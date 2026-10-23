import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntityManager } from '@mikro-orm/mysql';
import { CarrierSyncService, SYNC_ACTOR } from '../src/carrier-sync/carrier-sync.service.js';
import { CarrierAdapters } from '../src/carrier/carrier.adapters.js';
import { Carrier } from '../src/carrier/carrier.types.js';
import { CarrierEvent, Shipment, ShipmentStatus, SyncRun } from '../src/shipment/shipment.entities.js';
import { TerminalStatusHistory } from '../src/terminal/terminal-status-history.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { partners } from './helpers/partners.js';
import { resetQueues, waitFor, waitForQueuesIdle } from './helpers/queues.js';
import { allocateTo, prepareShipped, SCENARIO_OP, shipWith } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('택배 추적 자동 수집 (F3)', () => {
  let t: TestApp;
  let sync: CarrierSyncService;

  const em = () => t.orm.em.fork();
  const shipment = (id: number) => em().findOneOrFail(Shipment, id, { populate: ['terminal'] });
  const runs = (id: number) => em().find(SyncRun, { shipment: id }, { orderBy: { id: 'asc' } });
  const deliveredHistory = (serialNo: string) =>
    em().find(TerminalStatusHistory, { terminal: { serialNo }, toStatus: TerminalStatus.DELIVERED });

  /** sweep 한 번 → 큐가 빌 때까지 대기 */
  async function sweepOnce() {
    await sync.sweep();
    await waitForQueuesIdle(t.app);
  }

  beforeAll(async () => {
    t = await createTestApp({ workers: true });
    await resetDatabase(t.orm);
    await resetQueues(t.app);
    sync = t.app.get(CarrierSyncService);
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await t.app.close();
  });

  it('번개: sweep 네 번에 이벤트 4개, 단말기는 배치 경로로 DELIVERED', async () => {
    const { shipmentId } = await prepareShipped(t, 'CS-0001', 'BUNGAE');
    for (let i = 0; i < 3; i++) await sweepOnce();
    expect((await shipment(shipmentId)).status).toBe(ShipmentStatus.IN_TRANSIT);
    expect(await em().count(CarrierEvent, { shipment: shipmentId })).toBe(3);

    await sweepOnce();
    const s = await shipment(shipmentId);
    expect(s.status).toBe(ShipmentStatus.DELIVERED);
    expect(s.deliveredAt).toBeInstanceOf(Date);
    expect(s.terminal.status).toBe(TerminalStatus.DELIVERED);
    expect(await em().count(CarrierEvent, { shipment: shipmentId })).toBe(4);

    const history = await deliveredHistory('CS-0001');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromStatus: 'SHIPPED', source: 'BATCH', actor: SYNC_ACTOR });

    const r = await runs(shipmentId);
    expect(r.map((x) => x.outcome)).toEqual(['OK', 'OK', 'OK', 'DELIVERED']);
    expect(r.map((x) => x.inserted)).toEqual([1, 1, 1, 1]);
    expect(r.map((x) => x.duplicated)).toEqual([0, 1, 2, 3]); // 이미 저장한 이벤트는 다시 넣지 않는다
  });

  it('완료된 운송장은 sweep 대상이 아니다', async () => {
    const before = (await partners.stats()).calls['bungae.track'] ?? 0;
    await sweepOnce();
    expect((await partners.stats()).calls['bungae.track'] ?? 0).toBe(before);
  });

  it('번개 중복 이벤트(duplicateRate=1): 저장은 한 번, 중복으로 센다', async () => {
    await partners.configure({ bungae: { duplicateRate: 1, advancePerPoll: 4 } });
    const { shipmentId } = await prepareShipped(t, 'CS-0002', 'BUNGAE');
    await sweepOnce();
    expect(await em().count(CarrierEvent, { shipment: shipmentId })).toBe(4);
    const [run] = await runs(shipmentId);
    expect(run).toMatchObject({ outcome: 'DELIVERED', fetched: 8, inserted: 4, duplicated: 4 });
    expect(await deliveredHistory('CS-0002')).toHaveLength(1);
  });

  it('느림보: 순서가 섞인 XML도 공통 코드로 저장하고 DELIVERED', async () => {
    await partners.configure({ neurimbo: { shuffle: true, advancePerPoll: 4 } });
    const { shipmentId } = await prepareShipped(t, 'CS-0003', 'NEURIMBO');
    await sweepOnce();
    const events = await em().find(CarrierEvent, { shipment: shipmentId }, { orderBy: { occurredAt: 'asc' } });
    expect(events.map((e) => e.code)).toEqual(['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED']);
    expect((await shipment(shipmentId)).terminal.status).toBe(TerminalStatus.DELIVERED);
  });

  it('운영자가 먼저 수동으로 DELIVERED로 바꿨으면 단말기는 그대로 두고 운송장만 완료(no-op)', async () => {
    await partners.configure({ bungae: { advancePerPoll: 4 } });
    const { shipmentId } = await prepareShipped(t, 'CS-0004', 'BUNGAE');
    const version = (await t.http().get('/terminals/CS-0004')).body.version;
    await t
      .http()
      .post('/terminals/CS-0004/transitions')
      .set({ 'X-Operator': 'kang' })
      .send({ to: 'DELIVERED', reason: '가맹점 수령 확인 전화', expectedVersion: version });

    await sweepOnce();
    expect((await shipment(shipmentId)).status).toBe(ShipmentStatus.DELIVERED);
    const history = await deliveredHistory('CS-0004');
    expect(history.map((h) => h.source)).toEqual(['MANUAL']);
    const [run] = await runs(shipmentId);
    expect(run).toMatchObject({ outcome: 'NOOP', detail: '단말기 상태가 DELIVERED라 전이하지 않음' });
  });

  it('429면 Retry-After만큼 기다렸다가 재시도해 성공', async () => {
    const { shipmentId } = await prepareShipped(t, 'CS-0005', 'BUNGAE');
    await partners.configure({ bungae: { force429Rate: 1, retryAfterSec: 1 } });
    await sync.sweep();
    await waitFor(async () => (await runs(shipmentId)).length >= 1, { message: '첫 시도' });
    await partners.configure({ bungae: { force429Rate: 0 } });
    await waitForQueuesIdle(t.app);

    const r = await runs(shipmentId);
    expect(r.map((x) => [x.attempt, x.outcome])).toEqual([
      [1, 'ERROR'],
      [2, 'OK'],
    ]);
    expect(r[0].detail).toContain('PartnerRateLimitedError');
    // 두 번째 시도는 Retry-After(1초) 이후에 시작했다.
    expect(r[1].startedAt.getTime() - r[0].startedAt.getTime()).toBeGreaterThanOrEqual(900);
  });

  it('없는 운송장(404)은 재시도하지 않는다', async () => {
    const { shipmentId } = await prepareShipped(t, 'CS-0006', 'BUNGAE');
    await partners.reset(); // 택배사가 운송장을 잊었다
    await sweepOnce();
    const r = await runs(shipmentId);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ attempt: 1, outcome: 'ERROR' });
    expect(r[0].detail).toContain('PartnerPermanentError');
  });

  it('반영 직전에 같은 단말기가 다시 출고돼 운송장이 SUPERSEDED면 단말기를 바꾸지 않는다(decisions/0018)', async () => {
    await partners.configure({ bungae: { advancePerPoll: 4 } });
    const { shipmentId } = await prepareShipped(t, 'CS-0007', 'BUNGAE');
    const adapter = t.app.get(CarrierAdapters).get(Carrier.BUNGAE);
    const original = adapter.track.bind(adapter);
    // 택배사 응답(DELIVERED 포함)을 받은 뒤 반영하기 전에, 다른 요청이 이 단말기를 다시 출고한 상황을 만든다.
    const spy = vi.spyOn(adapter, 'track').mockImplementationOnce(async (trackingNo) => {
      const events = await original(trackingNo);
      await em().nativeUpdate(Shipment, shipmentId, { status: ShipmentStatus.SUPERSEDED });
      return events;
    });
    try {
      expect(await sync.track(shipmentId, { queue: 'test', attempt: 1 })).toBe('NOOP');
    } finally {
      spy.mockRestore();
    }
    const s = await shipment(shipmentId);
    expect(s.status).toBe(ShipmentStatus.SUPERSEDED);
    expect(s.terminal.status).toBe(TerminalStatus.SHIPPED);
    expect(await deliveredHistory('CS-0007')).toHaveLength(0);
    const [run] = await runs(shipmentId);
    expect(run).toMatchObject({ outcome: 'NOOP', detail: '운송장이 이미 SUPERSEDED' });
  });

  it('반영이 읽은 뒤 재출고가 커밋돼도 옛 운송장의 SUPERSEDED를 덮어쓰지 않는다(lost update, troubleshooting/0010)', async () => {
    await partners.configure({ bungae: { advancePerPoll: 4 } });
    const { shipmentId } = await prepareShipped(t, 'CS-0008', 'BUNGAE');
    // 운송장 추적이 늦는 사이 운영자가 수동으로 배송 완료 → 설치 → 회수 → 재고 → 재배정까지 진행했다(옛 운송장은 IN_TRANSIT 그대로).
    for (const to of ['DELIVERED', 'IN_SERVICE', 'RETURN_REQUESTED', 'RETURNING', 'RETURNED', 'IN_STOCK']) {
      const version = (await t.http().get('/terminals/CS-0008')).body.version;
      const res = await t.http().post('/terminals/CS-0008/transitions').set(SCENARIO_OP).send({ to, reason: '시나리오', expectedVersion: version });
      expect(res.status).toBe(200);
    }
    await allocateTo(t, 'CS-0008');

    // 반영 트랜잭션이 운송장(+단말기)을 읽은 직후(스냅샷: 운송장 IN_TRANSIT, 단말기 ALLOCATED)에 멈춰 두고, 그동안 재출고를 커밋시킨다.
    // 재출고는 hook 안이 아니라 테스트 쪽에서 보낸다. hook 안에서 HTTP를 보내면 MikroORM 트랜잭션 컨텍스트(AsyncLocalStorage)가
    // 요청 처리로 이어져 재출고가 같은 트랜잭션 안에서 실행된다(troubleshooting/0010 확인 1).
    let reachedRead!: () => void;
    const reached = new Promise<void>((r) => (reachedRead = r));
    let resumeApply!: () => void;
    const resume = new Promise<void>((r) => (resumeApply = r));
    const original = EntityManager.prototype.findOneOrFail;
    const spy = vi.spyOn(EntityManager.prototype, 'findOneOrFail').mockImplementationOnce(async function (this: EntityManager, ...args: unknown[]) {
      const found = await (original as (...a: unknown[]) => Promise<unknown>).apply(this, args);
      reachedRead();
      await resume;
      return found;
    } as typeof original);
    let outcome: string;
    let reshipped: number;
    try {
      const tracking = sync.track(shipmentId, { queue: 'test', attempt: 1 });
      await reached;
      reshipped = (await shipWith(t, 'CS-0008', 'BUNGAE')).shipmentId;
      resumeApply();
      outcome = await tracking;
    } finally {
      resumeApply();
      spy.mockRestore();
    }

    const old = await shipment(shipmentId);
    expect({ status: old.status, deliveredAt: old.deliveredAt ?? null }).toEqual({ status: ShipmentStatus.SUPERSEDED, deliveredAt: null });
    expect(old.terminal.status).toBe(TerminalStatus.SHIPPED);
    expect((await shipment(reshipped)).status).toBe(ShipmentStatus.IN_TRANSIT);
    expect(outcome).toBe('NOOP');
    const [run] = await runs(shipmentId);
    expect(run).toMatchObject({ outcome: 'NOOP', detail: '운송장이 반영 중에 IN_TRANSIT가 아니게 됨(재출고 등)' });
  });
});
