import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PurchaseOrder, PurchaseOrderStatus } from '../src/purchase-order/purchase-order.entity.js';
import { partners } from './helpers/partners.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'jung' };

describe('발주 (F10)', () => {
  let t: TestApp;
  const factoryCalls = async () => (await partners.stats()).calls['seum.purchaseOrder'] ?? 0;

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

  it('발주하면 세움전자에 발주하고 그 발주번호로 저장한다(ORDERED)', async () => {
    const res = await t.http().post('/purchase-orders').set(OP).send({ modelCode: 'SN-100', quantity: 20 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ modelCode: 'SN-100', quantity: 20, status: 'ORDERED', orderedBy: 'jung', closedAt: null });
    expect(res.body.poNo).toMatch(/^SE\d+$/);
    expect(await factoryCalls()).toBe(1);

    const saved = await t.orm.em.fork().findOneOrFail(PurchaseOrder, { poNo: res.body.poNo });
    expect(saved.status).toBe(PurchaseOrderStatus.ORDERED);
    expect(saved.deliveryNote).toBeNull(); // 명세는 입고를 시작할 때 받아 온다

    const got = await t.http().get(`/purchase-orders/${res.body.poNo}`);
    expect(got.status).toBe(200);
    // createdAt은 DB datetime(초 단위)로 저장돼 응답과 밀리초가 다를 수 있어 비교에서 뺀다.
    expect({ ...got.body, createdAt: undefined }).toEqual({ ...res.body, createdAt: undefined });
  });

  it('없는 모델이면 404이고 공장을 부르지 않는다', async () => {
    const res = await t.http().post('/purchase-orders').set(OP).send({ modelCode: 'SN-999', quantity: 5 });
    expect(res.status).toBe(404);
    expect(await factoryCalls()).toBe(0);
  });

  it('공장이 503이면 502 PARTNER_ERROR, 발주는 저장하지 않는다', async () => {
    await partners.configure({ seum: { error5xxRate: 1 } });
    const before = await t.orm.em.fork().count(PurchaseOrder);
    const res = await t.http().post('/purchase-orders').set(OP).send({ modelCode: 'SN-100', quantity: 5 });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'PARTNER_ERROR', reason: 'PartnerTransientError' });
    expect(await t.orm.em.fork().count(PurchaseOrder)).toBe(before);
  });

  it('수량은 1~5000, 작업자 헤더 필수', async () => {
    expect((await t.http().post('/purchase-orders').set(OP).send({ modelCode: 'SN-100', quantity: 0 })).status).toBe(400);
    expect((await t.http().post('/purchase-orders').set(OP).send({ modelCode: 'SN-100', quantity: 5001 })).status).toBe(400);
    expect((await t.http().post('/purchase-orders').send({ modelCode: 'SN-100', quantity: 1 })).status).toBe(400);
  });

  it('없는 발주번호는 404', async () => {
    expect((await t.http().get('/purchase-orders/SE0')).status).toBe(404);
  });
});
