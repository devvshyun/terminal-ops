import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PartnerPermanentError, PartnerTransientError } from '../src/common/partner-errors.js';
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
  describe('fix: 시간 기준 하트비트·후보 수 안전장치·키 정규화·후보 하나의 영구 오류', () => {
    const saved = { ...env };
    let now = 0;
    beforeEach(async () => {
      await resetDatabase(t.orm);
      now = 1_000_000;
      svc.clock = () => now;
    });
    afterEach(() => {
      svc.clock = () => Date.now();
      Object.assign(env, saved);
    });

    /** findBySerial을 감싸 호출마다 가짜 시계를 stepMs 앞으로 보내고, 첫 호출 뒤의 하트비트 수를 센다 */
    function watch(stepMs: number, fail?: (serialNo: string, call: number) => Error | null) {
      const client = t.app.get(BridgevanClient);
      const original = client.findBySerial.bind(client);
      const seen = { calls: 0, beatsAfterFirstCall: 0, serials: [] as string[] };
      const heartbeat = svc.heartbeat.bind(svc);
      vi.spyOn(svc, 'heartbeat').mockImplementation(async (runId) => {
        if (seen.calls > 0) seen.beatsAfterFirstCall++;
        return heartbeat(runId);
      });
      vi.spyOn(client, 'findBySerial').mockImplementation(async (serialNo) => {
        seen.calls++;
        seen.serials.push(serialNo);
        now += stepMs;
        const error = fail?.(serialNo, seen.calls);
        if (error) throw error;
        return original(serialNo);
      });
      return seen;
    }

    it('재검증 한 블록 안에서도 마지막 하트비트 뒤 간격(30초)이 지나면 동시 묶음 사이에 하트비트를 보낸다', async () => {
      // 후보 20개 = 블록 1개, 동시 8개씩 묶음 3개(8·8·4). 호출마다 가짜 시계 31초
      await insertTerminals(t, Array.from({ length: 20 }, (_, i) => ({ serialNo: `VT-${String(i + 1).padStart(2, '0')}`, status: S.IN_SERVICE, merchantCode: G })));
      const seen = watch(31_000);
      const done = await run();
      expect(done).toMatchObject({ status: VanRunStatus.COMPLETED, candidates: 20, confirmed: 20 });
      expect(seen.calls).toBe(20);
      expect(seen.beatsAfterFirstCall).toBe(2); // 둘째·셋째 묶음 앞(블록 첫머리 하트비트는 첫 호출 전)
    });

    it('간격이 안 지났으면 묶음 사이 하트비트를 보내지 않는다(호출마다 UPDATE하지 않음)', async () => {
      await insertTerminals(t, Array.from({ length: 20 }, (_, i) => ({ serialNo: `VT-${String(i + 1).padStart(2, '0')}`, status: S.IN_SERVICE, merchantCode: G })));
      const seen = watch(1_000);
      await run();
      expect(seen.beatsAfterFirstCall).toBe(0);
    });

    it('재시도를 기다리기 전에도 간격이 지났으면 하트비트를 보낸다(묶음 하나뿐이어도)', async () => {
      await insertTerminals(t, [{ serialNo: 'VT-01', status: S.IN_SERVICE, merchantCode: G }]);
      const seen = watch(31_000, (_s, call) => (call === 1 ? new PartnerTransientError('브릿지VAN 시리얼 조회 응답 503') : null));
      const done = await run();
      expect(done).toMatchObject({ status: VanRunStatus.COMPLETED, confirmed: 1, retries: 1 });
      expect(seen.calls).toBe(2);
      expect(seen.beatsAfterFirstCall).toBe(1);
    });

    it('안전장치: 후보가 max(절대 상한, 수집 수 × 비율)를 넘으면 재검증 전에 FAILED(이유), VAN 단건 조회·결과 행·알림 없음', async () => {
      env.vanCandidateAbsCap = 3;
      env.vanCandidateMaxPct = 20;
      // 수집 10, 후보 5(운영 중인데 VAN 없음) > max(3, 2)
      await insertTerminals(t, Array.from({ length: 5 }, (_, i) => ({ serialNo: `VS-${i + 1}`, status: S.IN_SERVICE, merchantCode: G })));
      await partners.seedVan(Array.from({ length: 10 }, (_, i) => reg(`T-VS-${i}`, `VX-${i}`, 'CANCELLED')));
      const seen = watch(0);
      const done = await run();
      expect(done).toMatchObject({ status: VanRunStatus.FAILED, fetched: 10, candidates: 5, confirmed: 0 });
      expect(done.error).toMatch(/VanSafetyValveError: 후보 5건이 상한 3건/);
      expect(seen.calls).toBe(0);
      expect(await items(done.id)).toEqual([]);
      expect(await em().count(OutboxEvent, { type: 'van.reconciliation_completed' })).toBe(0);
    });

    it('안전장치: 수집 수가 마지막 COMPLETED 실행의 50% 미만으로 줄면 FAILED(이유). 기준은 FAILED가 아니라 마지막 COMPLETED', async () => {
      await partners.seedVan(Array.from({ length: 10 }, (_, i) => reg(`T-VD-${i}`, `VD-${i}`, 'CANCELLED')));
      expect(await run()).toMatchObject({ status: VanRunStatus.COMPLETED, fetched: 10 });
      await partners.seedVan(Array.from({ length: 4 }, (_, i) => reg(`T-VD-${i}`, `VD-${i}`, 'CANCELLED')));
      const dropped = await run();
      expect(dropped).toMatchObject({ status: VanRunStatus.FAILED, fetched: 4 });
      expect(dropped.error).toMatch(/VanSafetyValveError: 수집 4건이 마지막 완료 실행 #\d+의 10건의 50% 미만/);
      await partners.seedVan(Array.from({ length: 6 }, (_, i) => reg(`T-VD-${i}`, `VD-${i}`, 'CANCELLED')));
      expect(await run()).toMatchObject({ status: VanRunStatus.COMPLETED, fetched: 6 });
    });

    it('키 정규화: VAN 시리얼이 대소문자·공백만 다르면 같은 단말기다(SQL과 재검증이 같은 판단, VAN 조회는 VAN 쪽 표기로)', async () => {
      await insertTerminals(t, [
        { serialNo: 'VK-01', status: S.IN_SERVICE, merchantCode: G }, // VAN 'vk-01' 정지 → 진짜 어긋남
        { serialNo: 'VK-02', status: S.IN_SERVICE, merchantCode: G }, // VAN 'vk-02' 활성, 가맹점 소문자 → 맞음
        { serialNo: 'VK-03', status: S.IN_SERVICE, merchantCode: G }, // VAN ' VK-03 ' 활성 → 맞음(공백 제거)
      ]);
      await partners.seedVan([reg('T-K1', 'vk-01', 'SUSPENDED'), reg('T-K2', 'vk-02', 'ACTIVE', 'gangnam-kimbap'), reg('T-K3', ' VK-03 ', 'ACTIVE')]);
      const seen = watch(0);
      const done = await run();
      expect(done).toMatchObject({ status: VanRunStatus.COMPLETED, fetched: 3, candidates: 1, confirmed: 1, resolved: 0 });
      expect((await items(done.id)).map((it) => [it.serialNo, it.kind, it.verified])).toEqual([['VK-01', 'SUSPENDED_WHILE_IN_SERVICE', true]]);
      expect(seen.serials).toEqual(['vk-01']);
      const k3 = await em().find(VanRegistrationSnapshot, { runId: done.id, tid: 'T-K3' });
      expect(k3.map((r) => r.serialNo)).toEqual(['VK-03']); // 공백을 지워 저장
    });

    it('VAN에 같은 시리얼(대소문자만 다름)이 둘이면 ACTIVE > SUSPENDED > CANCELLED로 하나를 고른다(다른 페이지여도)', async () => {
      env.bridgevanPageSize = 1; // 두 등록이 다른 페이지로 온다(tid 순: T-D1 활성, T-D2 해지)
      await insertTerminals(t, [{ serialNo: 'VDUP-01', status: S.IN_SERVICE, merchantCode: G }]);
      await partners.seedVan([reg('T-D1', 'vdup-01', 'ACTIVE'), reg('T-D2', 'VDUP-01', 'CANCELLED')]);
      const done = await run();
      expect(done).toMatchObject({ status: VanRunStatus.COMPLETED, pages: 2, fetched: 2, candidates: 0 });
      const snap = await em().find(VanRegistrationSnapshot, { runId: done.id });
      expect(snap.map((r) => [r.serialNo.toUpperCase(), r.status, r.tid])).toEqual([['VDUP-01', 'ACTIVE', 'T-D1']]);
    });

    it('후보 하나의 VAN 조회가 영구 오류(4xx·형식)면 그 후보만 확인 불가(verified=false + 이유)로 남기고 실행은 끝낸다', async () => {
      await insertTerminals(t, [
        { serialNo: 'VP-01', status: S.IN_SERVICE, merchantCode: G },
        { serialNo: 'VP-02', status: S.IN_SERVICE, merchantCode: G },
      ]);
      watch(0, (serialNo) => (serialNo === 'VP-01' ? new PartnerPermanentError('브릿지VAN 시리얼 조회 응답 400') : null));
      const done = await run();
      expect(done).toMatchObject({ status: VanRunStatus.COMPLETED, candidates: 2, confirmed: 1, resolved: 0, unverifiable: 1 });
      expect((await items(done.id)).map((it) => [it.serialNo, it.verified, it.reason])).toEqual([
        ['VP-01', false, '재검증 실패: PartnerPermanentError: 브릿지VAN 시리얼 조회 응답 400'],
        ['VP-02', true, null],
      ]);
      const res = await t.http().get(`/van-reconciliations/${done.id}`);
      expect(res.body).toMatchObject({ unverifiable: 1 });
      expect(res.body.items[0]).toMatchObject({ serialNo: 'VP-01', reason: expect.stringMatching(/^재검증 실패/) });
    });

    it('스테이징 정리가 실패해도 실행은 COMPLETED로 남는다(경고만)', async () => {
      await partners.seedVan([reg('T-C1', 'VC-1', 'CANCELLED')]);
      vi.spyOn(svc, 'cleanupSnapshots').mockRejectedValue(new Error('정리 실패(테스트)'));
      expect(await run()).toMatchObject({ status: VanRunStatus.COMPLETED, error: null });
    });
  });
});
