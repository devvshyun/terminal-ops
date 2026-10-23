import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PurchaseOrder } from '../src/purchase-order/purchase-order.entity.js';
import { BulkRegistrationService } from '../src/terminal/bulk-registration.service.js';
import { partners } from './helpers/partners.js';
import { captureQueries } from './helpers/query-log.js';
import { orderPurchase } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'ryu' };

describe('발주 대비 입고 대조·마감 (F10)', () => {
  let t: TestApp;
  const scan = (scanId: string, poNo: string, serials: string[]) =>
    t.http().post('/scans').set(OP).send({ scanId, kind: 'RECEIVE', poNo, serials });
  const reconcile = (poNo: string) => t.http().get(`/purchase-orders/${poNo}/reconciliation`);
  const close = (poNo: string) => t.http().post(`/purchase-orders/${poNo}/close`).set(OP);

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('발주 수량·명세 수·입고 수와 미입고(missing)·명세 외(unexpected)·부족분(shortfall)을 DB에서 집계한다', async () => {
    // 공장 골칫거리: 2대 덜 보내고, 다른 발주의 시리얼 1개를 명세에 섞는다 → 명세 = 4 + 1
    await partners.configure({ seum: { shortfall: 2, foreignSerials: 1 } });
    const { poNo, serials } = await orderPurchase(t, 6);
    const own = serials.filter((s) => s.startsWith(`${poNo}-`));
    const foreign = serials.find((s) => !s.startsWith(`${poNo}-`))!;
    expect(own).toHaveLength(4);

    await scan('REC-BOX-0001', poNo, [own[0], own[1], 'SE999-0001']);
    await scan('REC-BOX-0002', poNo, [own[2], foreign, 'SE999-0002', 'SE999-0001']);

    const cap = captureQueries(t.orm);
    const res = await reconcile(poNo);
    cap.stop();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      poNo,
      modelCode: 'SN-100',
      status: 'RECEIVING',
      ordered: 6,
      noted: 5,
      received: 4,
      shortfall: 1,
      missing: [own[3]],
      unexpected: ['SE999-0001', 'SE999-0002'],
    });
    console.log(`[대조 쿼리] ${cap.queries.length}개: ${cap.queries.map((q) => q.slice(0, 40)).join(' | ')}`);
    expect(cap.selects()).toBeLessThanOrEqual(4);
  });

  it('입고 전이면 명세를 받아 와 전부 missing', async () => {
    const { poNo, serials } = await orderPurchase(t, 3);
    const res = await reconcile(poNo);
    expect(res.body).toMatchObject({ status: 'ORDERED', ordered: 3, noted: 3, received: 0, shortfall: 0, missing: serials, unexpected: [] });
  });

  it('명세에 같은 시리얼이 두 번 있어도 noted·missing에 한 번만 센다(공장이 그러지 않는다고 보지만 방어)', async () => {
    const { poNo, serials } = await orderPurchase(t, 2);
    await t.orm.em.fork().nativeUpdate(PurchaseOrder, { poNo }, { deliveryNote: [serials[0], serials[1], serials[0]] });
    const res = await reconcile(poNo);
    expect(res.body).toMatchObject({ ordered: 2, noted: 2, shortfall: 0, missing: [serials[0], serials[1]] });
  });

  it('마감하면 CLOSED와 마감 시점의 대조 결과를 주고, 이후 입고 스캔은 422 PO_CLOSED, 다시 마감하면 422', async () => {
    const { poNo, serials } = await orderPurchase(t, 2);
    await scan('REC-BOX-0101', poNo, [serials[0]]);
    const res = await close(poNo);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ poNo, status: 'CLOSED', closedBy: 'ryu', received: 1, missing: [serials[1]] });
    expect(res.body.closedAt).toEqual(expect.any(String));

    const late = await scan('REC-BOX-0102', poNo, [serials[1]]);
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('PO_CLOSED');
    const again = await close(poNo);
    expect(again.status).toBe(422);
    expect(again.body.code).toBe('PO_ALREADY_CLOSED');
  });

  it('명세가 없는 발주를 마감할 때 공장이 503이면 502이고 마감하지 않는다(명세를 마감 트랜잭션 전에 받는다)', async () => {
    const { poNo } = await orderPurchase(t, 2); // 명세는 partners에서 직접 받았고, 앱 DB의 delivery_note는 아직 null
    await partners.configure({ seum: { error5xxRate: 1 } });
    const res = await close(poNo);
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'PARTNER_ERROR', reason: 'PartnerTransientError' });
    expect((await t.http().get(`/purchase-orders/${poNo}`)).body).toMatchObject({ status: 'ORDERED', closedAt: null, closedBy: null });

    await partners.configure({ seum: { error5xxRate: 0 } });
    const retried = await close(poNo);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ status: 'CLOSED', noted: 2, received: 0 });
  });

  it('입고 스캔 트랜잭션이 발주 행을 잠근 동안 마감은 기다렸다가, 스캔이 커밋된 뒤 마감된다', async () => {
    const { poNo, serials } = await orderPurchase(t, 2);
    const bulk = t.app.get(BulkRegistrationService);
    const original = bulk.registerMany.bind(bulk);
    let release!: () => void;
    let markEntered!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const entered = new Promise<void>((r) => (markEntered = r));
    const spy = vi.spyOn(bulk, 'registerMany').mockImplementationOnce(async (...args) => {
      markEntered(); // 이 시점에 스캔 트랜잭션은 발주 행을 FOR UPDATE로 잡고 있다
      await released;
      return original(...args);
    });
    try {
      // supertest 요청은 then을 불러야 보내진다. 기다리지 않고 보내 두려고 then을 붙인다.
      const scanning = scan('REC-BOX-0201', poNo, serials).then((r) => r);
      await entered;
      let closedAt = 0;
      const closing = close(poNo).then((r) => ((closedAt = Date.now()), r));
      await new Promise((r) => setTimeout(r, 300));
      const closedWhileScanning = closedAt !== 0;
      const releasedAt = Date.now();
      release();
      expect((await scanning).status).toBe(201);
      const closed = await closing;
      expect(closedWhileScanning).toBe(false);
      expect(closedAt).toBeGreaterThanOrEqual(releasedAt);
      expect(closed.status).toBe(200);
      expect(closed.body).toMatchObject({ status: 'CLOSED', received: 2, missing: [] });
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it('없는 발주는 404', async () => {
    expect((await reconcile('SE0')).status).toBe(404);
    expect((await close('SE0')).status).toBe(404);
  });
});
