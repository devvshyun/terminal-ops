import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Shipment, ShipmentStatus } from '../src/shipment/shipment.entities.js';
import { TerminalStatusHistory } from '../src/terminal/terminal-status-history.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { partners } from './helpers/partners.js';
import { allocateTo, registerInStock } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'yoon' };

describe('출고 (F3)', () => {
  let t: TestApp;

  async function versionOf(serialNo: string): Promise<number> {
    return (await t.http().get(`/terminals/${serialNo}`)).body.version;
  }
  async function waybillCalls(): Promise<number> {
    const stats = await partners.stats();
    return (stats.calls['bungae.waybill'] ?? 0) + (stats.calls['neurimbo.invoice'] ?? 0);
  }

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    for (const serialNo of ['SH-0001', 'SH-0002', 'SH-0004', 'SH-0005']) {
      await registerInStock(t, serialNo);
      await allocateTo(t, serialNo);
    }
    await registerInStock(t, 'SH-0003'); // 배정하지 않은 재고
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('번개택배로 출고하면 운송장이 생기고 단말기는 SHIPPED', async () => {
    // 버전 조회를 요청 체인 안에서 await하면 supertest가 같은 서버를 두 번 listen/close해서 깨진다. 먼저 구한다.
    const version = await versionOf('SH-0001');
    const res = await t.http().post('/shipments').set(OP).send({ serialNo: 'SH-0001', carrier: 'BUNGAE', expectedVersion: version });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ serialNo: 'SH-0001', carrier: 'BUNGAE', status: 'IN_TRANSIT', terminal: { status: 'SHIPPED' } });
    expect(res.body.trackingNo).toMatch(/^BG\d+$/);

    const history = await t.http().get('/terminals/SH-0001/history');
    expect(history.body.at(-1)).toMatchObject({ toStatus: 'SHIPPED', actor: 'yoon', reason: `출고: BUNGAE ${res.body.trackingNo}` });
    expect(await waybillCalls()).toBe(1);

    const detail = await t.http().get(`/shipments/${res.body.id}`);
    expect(detail.body).toMatchObject({ id: res.body.id, trackingNo: res.body.trackingNo, status: 'IN_TRANSIT', events: [] });
  });

  it('느림보물류로 출고하면 NR 송장', async () => {
    // 버전 조회를 요청 체인 안에서 await하면 supertest가 같은 서버를 두 번 listen/close해서 깨진다. 먼저 구한다.
    const version = await versionOf('SH-0002');
    const res = await t.http().post('/shipments').set(OP).send({ serialNo: 'SH-0002', carrier: 'NEURIMBO', expectedVersion: version });
    expect(res.status).toBe(201);
    expect(res.body.trackingNo).toMatch(/^NR\d+$/);
  });

  it('배정되지 않은 단말기는 422이고 택배사를 부르지 않는다', async () => {
    // 버전 조회를 요청 체인 안에서 await하면 supertest가 같은 서버를 두 번 listen/close해서 깨진다. 먼저 구한다.
    const version = await versionOf('SH-0003');
    const res = await t.http().post('/shipments').set(OP).send({ serialNo: 'SH-0003', carrier: 'BUNGAE', expectedVersion: version });
    expect(res.status).toBe(422);
    expect(await waybillCalls()).toBe(0);
  });

  it('version이 다르면 409이고 택배사를 부르지 않는다', async () => {
    const res = await t.http().post('/shipments').set(OP).send({ serialNo: 'SH-0004', carrier: 'BUNGAE', expectedVersion: 1 });
    expect(res.status).toBe(409);
    expect(await waybillCalls()).toBe(0);
  });

  it('택배사가 503이면 502 PARTNER_ERROR, 단말기는 ALLOCATED 그대로', async () => {
    await partners.configure({ neurimbo: { error5xxRate: 1 } });
    // 버전 조회를 요청 체인 안에서 await하면 supertest가 같은 서버를 두 번 listen/close해서 깨진다. 먼저 구한다.
    const version = await versionOf('SH-0004');
    const res = await t.http().post('/shipments').set(OP).send({ serialNo: 'SH-0004', carrier: 'NEURIMBO', expectedVersion: version });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'PARTNER_ERROR', reason: 'PartnerTransientError' });
    expect((await t.http().get('/terminals/SH-0004')).body.status).toBe('ALLOCATED');
  });

  it('같은 단말기 동시 출고 2건: 1건만 성공, 운송장 저장 1건(남는 운송장은 고아로 센다)', async () => {
    const version = await versionOf('SH-0005');
    const responses = await Promise.all(
      [0, 1].map(() => t.http().post('/shipments').set(OP).send({ serialNo: 'SH-0005', carrier: 'BUNGAE', expectedVersion: version })),
    );
    const statuses = responses.map((r) => r.status).sort();
    const em = t.orm.em.fork();
    const saved = await em.count(Shipment, { terminal: { serialNo: 'SH-0005' } });
    const shippedHistory = await em.count(TerminalStatusHistory, { terminal: { serialNo: 'SH-0005' }, toStatus: TerminalStatus.SHIPPED });
    const calls = await waybillCalls();
    console.log(`[동시 출고] 응답=${JSON.stringify(statuses)} 운송장발급=${calls} 저장=${saved} 고아=${calls - saved}`);

    expect(statuses).toEqual([201, 409]);
    expect(saved).toBe(1);
    expect(shippedHistory).toBe(1);
    const shipment = await em.findOneOrFail(Shipment, { terminal: { serialNo: 'SH-0005' } });
    expect(shipment.status).toBe(ShipmentStatus.IN_TRANSIT);
  });

  it('없는 출고 id는 404, 숫자가 아니면 400', async () => {
    expect((await t.http().get('/shipments/9999')).status).toBe(404);
    expect((await t.http().get('/shipments/abc')).status).toBe(400);
  });
});
