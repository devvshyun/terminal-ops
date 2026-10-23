import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CarrierSyncService } from '../src/carrier-sync/carrier-sync.service.js';
import { CarrierAdapters } from '../src/carrier/carrier.adapters.js';
import { Carrier } from '../src/carrier/carrier.types.js';
import { Shipment, ShipmentStatus } from '../src/shipment/shipment.entities.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { partners } from './helpers/partners.js';
import { prepareInService, registerInStock, transitionTo } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'moon' };

describe('A/S 교체 출고·설치 확인 (F7)', () => {
  let t: TestApp;
  const em = () => t.orm.em.fork();
  const terminal = (serialNo: string) => em().findOneOrFail(Terminal, { serialNo }, { populate: ['merchant'] });
  const history = async (serialNo: string) => (await t.http().get(`/terminals/${serialNo}/history`)).body;
  const waybillCalls = async () => (await partners.stats()).calls['bungae.waybill'] ?? 0;
  const openTicket = async (serialNo: string) =>
    (await t.http().post('/service-tickets').set(OP).send({ serialNo, symptom: '카드 인식 불가' })).body.id as number;
  const replace = (id: number, replacementSerialNo: string) =>
    t.http().post(`/service-tickets/${id}/replacements`).set(OP).send({ replacementSerialNo, carrier: 'BUNGAE' });
  const install = (id: number) => t.http().post(`/service-tickets/${id}/installations`).set(OP);

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await partners.reset();
    for (const s of ['RP-0001', 'RP-0002', 'RP-0003', 'RP-0004', 'RP-0005']) await prepareInService(t, s, 'PANGYO-BUNSIK');
    for (const s of ['RP-0101', 'RP-0102', 'RP-0103', 'RP-0105']) await registerInStock(t, s);
    // 다른 모델(SN-200) 재고: 검수 항목이 달라 시나리오 헬퍼 대신 상태를 직접 맞춘다.
    await t.http().post('/terminals').set(OP).send({ serialNo: 'RP-0201', modelCode: 'SN-200' });
    await em().nativeUpdate(Terminal, { serialNo: 'RP-0201' }, { status: TerminalStatus.IN_STOCK });
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('교체 출고 → 배송 완료 → 설치 확인 → 고장 단말기 회수 스캔까지 한 흐름', async () => {
    const id = await openTicket('RP-0001');
    const res = await replace(id, 'RP-0101');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id, status: 'REPLACING', replacementSerialNo: 'RP-0101' });
    expect(res.body.outboundTrackingNo).toMatch(/^BG\d+$/);

    // 교체 단말기: 재고 → 배정(가맹점 = 접수 가맹점) → 출고. 고장 단말기: 회수 요청. 모두 한 트랜잭션.
    const replacement = await terminal('RP-0101');
    expect(replacement.status).toBe(TerminalStatus.SHIPPED);
    expect(replacement.merchant?.code).toBe('PANGYO-BUNSIK');
    expect((await terminal('RP-0001')).status).toBe(TerminalStatus.RETURN_REQUESTED);
    expect((await history('RP-0101')).slice(-2)).toMatchObject([
      { fromStatus: 'IN_STOCK', toStatus: 'ALLOCATED', source: 'ALLOCATION', actor: 'moon', reason: `A/S 교체 배정: 접수 #${id}` },
      { fromStatus: 'ALLOCATED', toStatus: 'SHIPPED', source: 'SHIPMENT', reason: `A/S 교체 출고: BUNGAE ${res.body.outboundTrackingNo}` },
    ]);
    expect((await history('RP-0001')).at(-1)).toMatchObject({ toStatus: 'RETURN_REQUESTED', source: 'SERVICE', reason: `A/S 교체로 회수 요청: 접수 #${id}` });
    const shipment = await em().findOneOrFail(Shipment, res.body.outboundShipmentId, { populate: ['terminal'] });
    expect([shipment.terminal.serialNo, shipment.status]).toEqual(['RP-0101', ShipmentStatus.IN_TRANSIT]);

    // 배송 전 설치 확인은 422(SHIPPED → IN_SERVICE 규칙 없음), 접수는 REPLACING 그대로
    const early = await install(id);
    expect(early.status).toBe(422);
    expect((await t.http().get(`/service-tickets/${id}`)).body.status).toBe('REPLACING');

    // 택배 추적 수집이 배송 완료를 반영한다(기존 F3 흐름)
    await partners.configure({ bungae: { advancePerPoll: 4 } });
    expect(await t.app.get(CarrierSyncService).track(shipment.id, { queue: 'test', attempt: 1 })).toBe('DELIVERED');

    const done = await install(id);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'CLOSED' });
    expect(done.body.closedAt).toEqual(expect.any(String));
    expect((await terminal('RP-0101')).status).toBe(TerminalStatus.IN_SERVICE);
    expect((await history('RP-0101')).at(-1)).toMatchObject({ toStatus: 'IN_SERVICE', source: 'SERVICE', reason: `A/S 교체 설치 확인: 접수 #${id}` });

    // 고장 단말기 회수: 수거 시작(수동) → 회수 박스 스캔
    await transitionTo(t, 'RP-0001', 'RETURNING', 'pickup');
    const scan = await t.http().post('/scans').set(OP).send({ scanId: 'AS-RETURN-0001', kind: 'RETURN_IN', serials: ['RP-0001'] });
    expect(scan.body.results).toEqual([{ serialNo: 'RP-0001', result: 'RETURNED' }]);
  });

  it('출고 전에 확인할 수 있는 실패는 택배사를 부르지 않는다(422·404)', async () => {
    const id = await openTicket('RP-0002');
    const notInStock = await replace(id, 'RP-0101'); // 앞 테스트에서 이미 설치됨
    expect(notInStock.status).toBe(422);
    expect(notInStock.body.code).toBe('REPLACEMENT_NOT_IN_STOCK');
    const otherModel = await replace(id, 'RP-0201');
    expect(otherModel.status).toBe(422);
    expect(otherModel.body.code).toBe('MODEL_MISMATCH');
    expect((await replace(id, 'RP-9999')).status).toBe(404);
    expect(await waybillCalls()).toBe(0);

    await t.http().post(`/service-tickets/${id}/remote-checks`).set(OP).send({ resolved: true, note: '해결' });
    const closed = await replace(id, 'RP-0102');
    expect(closed.status).toBe(422);
    expect(closed.body.code).toBe('TICKET_NOT_OPEN');
    expect(await waybillCalls()).toBe(0);
  });

  it('트랜잭션 안에서 하나라도 실패하면 두 단말기·운송장·접수가 모두 그대로(운송장은 고아로 남는다)', async () => {
    const id = await openTicket('RP-0003');
    // 운송장 발급 직후, 다른 작업이 고장 단말기를 먼저 회수 요청으로 바꾼 상황
    const adapter = t.app.get(CarrierAdapters).get(Carrier.BUNGAE);
    const original = adapter.createWaybill.bind(adapter);
    const spy = vi.spyOn(adapter, 'createWaybill').mockImplementationOnce(async (input) => {
      const trackingNo = await original(input);
      await em().nativeUpdate(Terminal, { serialNo: 'RP-0003' }, { status: TerminalStatus.RETURN_REQUESTED });
      return trackingNo;
    });
    try {
      const res = await replace(id, 'RP-0102');
      expect(res.status).toBe(422);
    } finally {
      spy.mockRestore();
    }
    const r = await terminal('RP-0102');
    expect([r.status, r.merchant]).toEqual([TerminalStatus.IN_STOCK, null]);
    expect(await em().count(Shipment, { terminal: { serialNo: 'RP-0102' } })).toBe(0);
    expect((await t.http().get(`/service-tickets/${id}`)).body).toMatchObject({ status: 'OPEN', replacementSerialNo: null });
    expect(await waybillCalls()).toBe(1); // 발급된 운송장 1장은 저장되지 않았다(decisions/0012 한계)
  });

  it('두 접수가 같은 교체 단말기를 동시에 요청하면 1건만 성공, 나머지는 422', async () => {
    const [a, b] = [await openTicket('RP-0004'), await openTicket('RP-0005')];
    const results = await Promise.all([replace(a, 'RP-0105'), replace(b, 'RP-0105')]);
    const statuses = results.map((r) => r.status).sort();
    console.log(`[같은 교체 단말기 동시 요청] 응답=${JSON.stringify(statuses)} 코드=${JSON.stringify(results.map((r) => r.body.code ?? null))} 운송장발급=${await waybillCalls()}`);
    expect(statuses).toEqual([201, 422]);
    expect(await em().count(Shipment, { terminal: { serialNo: 'RP-0105' } })).toBe(1);
    const loser = results.find((r) => r.status === 422)!;
    const loserTicket = loser === results[0] ? a : b;
    expect((await t.http().get(`/service-tickets/${loserTicket}`)).body.status).toBe('OPEN');
  });
});
