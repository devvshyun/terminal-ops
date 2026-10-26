import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import { OutboxEvent } from '../src/outbox/outbox-event.entity.js';
import { TerminalStatus as S } from '../src/terminal/terminal-status.js';
import { VanReconciliationItem, VanReconciliationRun, VanRegistrationSnapshot, VanRunStatus, VanRunTrigger } from '../src/van/van.entities.js';
import { BridgevanClient } from '../src/van/bridgevan.client.js';
import { VanReconciliationService } from '../src/van/van-reconciliation.service.js';
import { partners, type VanSeed } from './helpers/partners.js';
import { insertTerminals } from './helpers/terminals.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const G = 'GANGNAM-KIMBAP';
const Y = 'YEOKSAM-CAFE';
const reg = (tid: string, serialNo: string, status: VanSeed['status'], merchantCode = G, healTo?: VanSeed['healTo']): VanSeed => ({
  tid,
  serialNo,
  merchantCode,
  status,
  ...(healTo ? { healTo } : {}),
});

describe('VAN 등록 대조 — 집합 비교·재검증·결과·알림·스테이징 정리 (F9)', () => {
  let t: TestApp;
  let svc: VanReconciliationService;
  const em = () => t.orm.em.fork();
  const pageSize = env.bridgevanPageSize;
  const run = async () => svc.execute((await svc.start(VanRunTrigger.MANUAL, 'kim')).id);
  const items = (runId: number) => em().find(VanReconciliationItem, { run: runId }, { orderBy: { id: 'asc' } });

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    svc = t.app.get(VanReconciliationService);
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    env.bridgevanPageSize = pageSize;
    await t.app.close();
  });

  it('네 종류의 어긋남을 찾고 어긋나지 않은 것은 남기지 않는다. 결과는 시리얼 순, 요약 알림은 1행', async () => {
    await insertTerminals(t, [
      ...Array.from({ length: 10 }, (_, i) => ({ serialNo: `VR-${String(i + 1).padStart(3, '0')}`, status: S.IN_SERVICE, merchantCode: G })),
      { serialNo: 'VR-011', status: S.IN_SERVICE, merchantCode: G }, // VAN 없음
      { serialNo: 'VR-012', status: S.IN_SERVICE, merchantCode: G }, // VAN 해지
      { serialNo: 'VR-013', status: S.RETURNED }, // VAN 활성
      { serialNo: 'VR-014', status: S.IN_SERVICE, merchantCode: G }, // VAN 가맹점 다름
      { serialNo: 'VR-015', status: S.IN_SERVICE, merchantCode: null }, // 우리 가맹점 없음
      { serialNo: 'VR-016', status: S.IN_SERVICE, merchantCode: G }, // VAN 정지
      { serialNo: 'VR-017', status: S.DISPOSED }, // VAN 해지 — 어긋남 아님
      { serialNo: 'VR-018', status: S.RETURNED }, // VAN 정지 — 어긋남 아님
    ]);
    await partners.seedVan([
      ...Array.from({ length: 10 }, (_, i) => reg(`T-VR-${i + 1}`, `VR-${String(i + 1).padStart(3, '0')}`, 'ACTIVE')),
      reg('T-VR-12', 'VR-012', 'CANCELLED'),
      reg('T-VR-13', 'VR-013', 'ACTIVE'),
      reg('T-VR-14', 'VR-014', 'ACTIVE', Y),
      reg('T-VR-15', 'VR-015', 'ACTIVE'),
      reg('T-VR-16', 'VR-016', 'SUSPENDED'),
      reg('T-VR-17', 'VR-017', 'CANCELLED'),
      reg('T-VR-18', 'VR-018', 'SUSPENDED'),
      reg('T-VR-99', 'VR-099', 'ACTIVE'), // 우리 DB에 없음
    ]);

    const done = await run();
    expect(done).toMatchObject({ status: VanRunStatus.COMPLETED, fetched: 18, candidates: 7, confirmed: 7, resolved: 0, error: null });
    expect(done.counts).toEqual({ NOT_REGISTERED: 2, REGISTERED_BUT_NOT_IN_SERVICE: 2, MERCHANT_MISMATCH: 2, SUSPENDED_WHILE_IN_SERVICE: 1 });
    expect(Object.keys(done.phaseMs ?? {})).toEqual(['collect', 'compare', 'reverify']);
    expect((await items(done.id)).map((it) => [it.serialNo, it.kind, it.ourValue, it.vanValue, it.verified])).toEqual([
      ['VR-011', 'NOT_REGISTERED', `IN_SERVICE / ${G}`, 'VAN에 없음', true],
      ['VR-012', 'NOT_REGISTERED', `IN_SERVICE / ${G}`, `CANCELLED / ${G}`, true],
      ['VR-013', 'REGISTERED_BUT_NOT_IN_SERVICE', 'RETURNED / 가맹점 없음', `ACTIVE / ${G}`, true],
      ['VR-014', 'MERCHANT_MISMATCH', `IN_SERVICE / ${G}`, `ACTIVE / ${Y}`, true],
      ['VR-015', 'MERCHANT_MISMATCH', 'IN_SERVICE / 가맹점 없음', `ACTIVE / ${G}`, true],
      ['VR-016', 'SUSPENDED_WHILE_IN_SERVICE', `IN_SERVICE / ${G}`, `SUSPENDED / ${G}`, true],
      ['VR-099', 'REGISTERED_BUT_NOT_IN_SERVICE', '우리 DB에 없음', `ACTIVE / ${G}`, true],
    ]);
    // 재검증은 후보마다 VAN 시리얼 조회 1번(목록 1페이지 + 7)
    expect((await partners.stats()).calls['bridgevan.list']).toBe(1 + 7);
    const events = await em().find(OutboxEvent, { type: 'van.reconciliation_completed' });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ runId: done.id, fetched: 18, candidates: 7, confirmed: 7, resolved: 0 });
  });

  it('스캔 도중 VAN이 바뀌면: 이미 풀린 후보는 재검증이 거르고(verified=false), 지나간 자리에 새로 생긴 어긋남은 다음 실행이 잡는다', async () => {
    await resetDatabase(t.orm); // 앞 테스트의 단말기가 이번 VAN 목록에 없어 후보로 섞이지 않게
    await insertTerminals(t, Array.from({ length: 10 }, (_, i) => ({ serialNo: `VM-${String(i + 1).padStart(2, '0')}`, status: S.IN_SERVICE, merchantCode: G })));
    // 페이지 5건: 첫 페이지(T01~T05)는 둘째 페이지를 부를 때 모두 바뀐다(mutateDuringScan 5)
    await partners.seedVan([
      reg('T01', 'VM-01', 'SUSPENDED', G, { status: 'ACTIVE' }), // 스냅샷에는 정지, 곧 풀림
      reg('T02', 'VM-02', 'SUSPENDED', G, { status: 'ACTIVE' }),
      reg('T03', 'VM-03', 'SUSPENDED', G, { status: 'ACTIVE' }),
      reg('T04', 'VM-04', 'ACTIVE', Y, { merchantCode: G }), // 스냅샷에는 가맹점 다름, 곧 풀림
      reg('T05', 'VM-05', 'ACTIVE'), // 맞던 등록이 지나간 뒤 정지로 바뀜(이번 스냅샷은 모른다)
      reg('T06', 'VM-06', 'ACTIVE'),
      reg('T07', 'VM-07', 'ACTIVE'),
      reg('T08', 'VM-08', 'SUSPENDED'), // 진짜 어긋남(풀리지 않음)
      reg('T09', 'VM-09', 'ACTIVE'),
      reg('T10', 'VM-10', 'ACTIVE'),
    ]);
    await partners.configure({ seed: 5, bridgevan: { mutateDuringScan: 5 } });
    env.bridgevanPageSize = 5;

    const first = await run();
    expect(await partners.stats()).toMatchObject({ vanMutated: 5, vanHealed: 4 });
    expect(first).toMatchObject({ status: VanRunStatus.COMPLETED, pages: 2, fetched: 10, candidates: 5, confirmed: 1, resolved: 4 });
    const firstItems = await items(first.id);
    expect(firstItems.filter((it) => it.verified).map((it) => [it.serialNo, it.kind])).toEqual([['VM-08', 'SUSPENDED_WHILE_IN_SERVICE']]);
    expect(firstItems.filter((it) => !it.verified).map((it) => [it.serialNo, it.kind, it.vanValue])).toEqual([
      ['VM-01', 'SUSPENDED_WHILE_IN_SERVICE', `SUSPENDED / ${G}`],
      ['VM-02', 'SUSPENDED_WHILE_IN_SERVICE', `SUSPENDED / ${G}`],
      ['VM-03', 'SUSPENDED_WHILE_IN_SERVICE', `SUSPENDED / ${G}`],
      ['VM-04', 'MERCHANT_MISMATCH', `ACTIVE / ${Y}`],
    ]);
    expect(firstItems.map((it) => it.serialNo)).not.toContain('VM-05');

    // 다음 실행(변경 없음): 지나간 자리에서 정지로 바뀐 VM-05를 잡고, 풀린 것들은 후보에도 없다
    await partners.configure({ bridgevan: { mutateDuringScan: 0 } });
    const second = await run();
    expect(second).toMatchObject({ candidates: 2, confirmed: 2, resolved: 0 });
    expect((await items(second.id)).map((it) => it.serialNo)).toEqual(['VM-05', 'VM-08']);
    // 스테이징은 이번 실행 것만 남는다(앞 실행 것은 run_id로 지움)
    expect(await em().count(VanRegistrationSnapshot, { runId: first.id })).toBe(0);
    expect(await em().count(VanRegistrationSnapshot, { runId: second.id })).toBe(10);
    env.bridgevanPageSize = pageSize;
  });

  it('GET /van-reconciliations/:id 는 요약과 결과 한 페이지(afterId 키셋, 종류·재검증 조건)', async () => {
    const latest = (await em().find(VanReconciliationItem, { verified: false }, { populate: ['run'], limit: 1 }))[0].run.id;
    const all = await t.http().get(`/van-reconciliations/${latest}`);
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ id: latest, status: 'COMPLETED', confirmed: 1, resolved: 4, nextAfterId: null });
    expect(all.body.items).toHaveLength(5);

    const p1 = await t.http().get(`/van-reconciliations/${latest}?limit=2`);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextAfterId).toBe(p1.body.items[1].id);
    const p2 = await t.http().get(`/van-reconciliations/${latest}?limit=2&afterId=${p1.body.nextAfterId}`);
    expect(p2.body.items[0].id).toBeGreaterThan(p1.body.nextAfterId);

    const resolved = await t.http().get(`/van-reconciliations/${latest}?verified=false&kind=MERCHANT_MISMATCH`);
    expect(resolved.body.items.map((it: { serialNo: string }) => it.serialNo)).toEqual(['VM-04']);
    expect((await t.http().get(`/van-reconciliations/${latest}?kind=WRONG`)).status).toBe(400);
    expect((await t.http().get(`/van-reconciliations/${latest}?limit=501`)).status).toBe(400);
  });
  it('재검증도 블록(100개)마다 하트비트를 보낸다: 도중에 실행이 FAILED가 되면 다음 블록을 부르지 않고 결과·알림을 쓰지 않는다 (fix 커밋과 합침)', async () => {
    await resetDatabase(t.orm);
    // 운영 중인데 VAN에 없음 101대 → 후보 101개 = 블록 2개
    await insertTerminals(t, Array.from({ length: 101 }, (_, i) => ({ serialNo: `VH-${String(i + 1).padStart(3, '0')}`, status: S.IN_SERVICE, merchantCode: G })));
    const started = await svc.start(VanRunTrigger.MANUAL, 'kim');
    const client = t.app.get(BridgevanClient);
    const original = client.findBySerial.bind(client);
    let calls = 0;
    vi.spyOn(client, 'findBySerial').mockImplementation(async (serialNo) => {
      // 첫 블록 도중 다른 시작이 이 실행을 멈춘 것으로 보고 FAILED로 바꿨다
      if (++calls === 1) await em().nativeUpdate(VanReconciliationRun, { id: started.id }, { status: VanRunStatus.FAILED, error: '멈춘 실행(테스트)' });
      return original(serialNo);
    });
    const done = await svc.execute(started.id);
    expect(calls).toBe(100);
    expect(done).toMatchObject({ status: VanRunStatus.FAILED, error: '멈춘 실행(테스트)', candidates: 0, confirmed: 0 });
    expect(await items(started.id)).toEqual([]);
    expect(await em().count(OutboxEvent, { type: 'van.reconciliation_completed', payload: { runId: started.id } })).toBe(0);
  });
});
