import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { Anomaly, AnomalyRule } from '../src/anomaly/anomaly.entity.js';
import { env } from '../src/config/env.js';
import { DashboardQueries } from '../src/dashboard/dashboard.queries.js';
import { dashboardCacheKey, DashboardService } from '../src/dashboard/dashboard.service.js';
import { Firmware, FirmwareRollout, RolloutStatus } from '../src/firmware/firmware.entities.js';
import { Merchant } from '../src/merchant/merchant.entity.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { kstWeekOf } from '../src/report/kst-week.js';
import { ServiceTicket, ServiceTicketStatus } from '../src/service/service-ticket.entity.js';
import { TerminalModel } from '../src/terminal/terminal-model.entity.js';
import { TerminalStatus as S } from '../src/terminal/terminal-status.js';
import { VanReconciliationRun, VanRunStatus, VanRunTrigger } from '../src/van/van.entities.js';
import { captureQueries } from './helpers/query-log.js';
import { insertTerminals } from './helpers/terminals.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

/** 어드민 처음 화면의 집계와 Redis 캐시(decisions/0044). 날짜는 "지금"에서 계산한다(고정 날짜에 기대지 않는다, troubleshooting/0026) */
describe('대시보드 집계와 캐시 (decisions/0044)', () => {
  let t: TestApp;
  let redis: Redis;
  let ids: Map<string, number>;
  /** 가장 최근에 끝난 VAN 실행 id, 이번 주 월요일(KST) — beforeAll이 채운다 */
  let latestVanRun = 0;
  let vanFinishedAt = 0;
  let weekStart = '';
  const em = () => t.orm.em.fork();
  const get = (query: Record<string, string> = {}) => t.http().get('/dashboard/summary').query(query);

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    redis = t.app.get<Redis>(REDIS);
    ids = await insertTerminals(t, [
      { serialNo: 'DB-01', status: S.IN_SERVICE, merchantCode: 'GANGNAM-KIMBAP' },
      { serialNo: 'DB-02', status: S.IN_SERVICE, merchantCode: 'GANGNAM-KIMBAP' },
      { serialNo: 'DB-03', status: S.IN_SERVICE, merchantCode: 'YEOKSAM-CAFE', modelCode: 'SN-200' },
      { serialNo: 'DB-04', status: S.IN_STOCK },
      { serialNo: 'DB-05', status: S.IN_STOCK, modelCode: 'SN-200' },
      { serialNo: 'DB-06', status: S.DISPOSED },
    ]);
    const now = new Date();
    // 접속 상태: DB-01 온라인(방금), DB-02 오프라인 플래그, DB-03 기록 없음
    await em().execute(
      'insert into device_connectivity (terminal_id, online, last_seen_at, firmware_version, changed_at) values (?, 1, ?, ?, ?), (?, 0, ?, ?, ?)',
      [ids.get('DB-01'), now, '1.0.0', now, ids.get('DB-02'), new Date(now.getTime() - 3_600_000), '1.0.0', now],
    );
    // 이상: 열린 것 셋(규칙 둘), 닫힌 것 하나
    await em().insert(Anomaly, { terminalId: ids.get('DB-04')!, rule: AnomalyRule.RETURN_STALLED, detectedAt: now, lastSeenAt: now, detail: {} });
    await em().insert(Anomaly, { terminalId: ids.get('DB-02')!, rule: AnomalyRule.OFFLINE_TOO_LONG, detectedAt: now, lastSeenAt: now, detail: {} });
    await em().insert(Anomaly, { terminalId: ids.get('DB-03')!, rule: AnomalyRule.OFFLINE_TOO_LONG, detectedAt: now, lastSeenAt: now, detail: {} });
    await em().insert(Anomaly, { terminalId: ids.get('DB-05')!, rule: AnomalyRule.DELIVERED_NOT_INSTALLED, detectedAt: now, lastSeenAt: now, resolvedAt: now, detail: {} });
    // 배포: 진행 중 1, 멈춤 1, 끝남 1 / A/S: 열림 1, 교체 중 1, 닫힘 1 / VAN: 끝난 실행 둘(최근 것만), 실패 하나
    const e = em();
    const model = await e.findOneOrFail(TerminalModel, { code: 'SN-100' });
    const merchant = await e.findOneOrFail(Merchant, { code: 'GANGNAM-KIMBAP' });
    for (const [version, status] of [['8.0.1', RolloutStatus.RUNNING], ['8.0.2', RolloutStatus.PAUSED], ['8.0.3', RolloutStatus.COMPLETED]] as const) {
      e.create(FirmwareRollout, { firmware: e.create(Firmware, { model, version, createdBy: 'han' }), stages: [100], failureThreshold: 0.2, minSamples: 3, stageTimeoutMs: 60_000, createdBy: 'han', status });
    }
    for (const status of [ServiceTicketStatus.OPEN, ServiceTicketStatus.REPLACING, ServiceTicketStatus.CLOSED]) {
      e.create(ServiceTicket, { terminal: ids.get('DB-01')!, merchant, symptom: '전원', openedBy: 'han', status } as never);
    }
    const run = (status: VanRunStatus, confirmed: number) =>
      e.create(VanReconciliationRun, { trigger: VanRunTrigger.MANUAL, requestedBy: 'han', startedAt: now, heartbeatAt: now, finishedAt: now, status, confirmed, counts: { NOT_REGISTERED: confirmed } });
    run(VanRunStatus.COMPLETED, 5);
    const latest = run(VanRunStatus.COMPLETED, 2);
    run(VanRunStatus.FAILED, 9);
    await e.flush();
    latestVanRun = latest.id;
    vanFinishedAt = now.getTime();
    // 이력: 이번 주 시작 시각(포함)에 둘, 그 1초 전(지난주)에 하나
    const week = kstWeekOf(now);
    const history = 'insert into terminal_status_history (terminal_id, from_status, to_status, source, actor, reason, occurred_at) values (?, ?, ?, ?, ?, ?, ?)';
    await em().execute(history, [ids.get('DB-01'), 'DELIVERED', 'IN_SERVICE', 'MANUAL', 'han', 'r', week.from]);
    await em().execute(history, [ids.get('DB-02'), 'DELIVERED', 'IN_SERVICE', 'MANUAL', 'han', 'r', week.from]);
    await em().execute(history, [ids.get('DB-03'), 'DELIVERED', 'IN_SERVICE', 'MANUAL', 'han', 'r', new Date(week.from.getTime() - 1_000)]);
    weekStart = week.weekStart;
  });
  beforeEach(async () => {
    await redis.del(dashboardCacheKey());
  });
  afterAll(async () => {
    await redis.del(dashboardCacheKey());
    await t.app.close();
  });

  it('상태·모델별 단말기 수, 접속 상태, 열린 이상(규칙 순서), 진행 중 배포, 열린 A/S, 최근 VAN, 이번 주 전이 수', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      terminals: {
        total: 6,
        byStatus: [
          { status: 'IN_STOCK', count: 2 },
          { status: 'IN_SERVICE', count: 3 },
          { status: 'DISPOSED', count: 1 },
        ],
        byModel: [
          { modelCode: 'SN-100', count: 4 },
          { modelCode: 'SN-200', count: 2 },
        ],
      },
      connectivity: { inService: 3, online: 1, offline: 1, noRecord: 1 },
      anomalies: {
        open: 3,
        byRule: [
          { rule: 'RETURN_STALLED', label: '회수 지연', open: 1 },
          { rule: 'OFFLINE_TOO_LONG', label: '장기 오프라인', open: 2 },
        ],
      },
      rollouts: { active: 2 },
      serviceTickets: { open: 2 },
      van: { runId: latestVanRun, confirmed: 2, counts: { NOT_REGISTERED: 2 } },
      week: { weekStart, transitions: 2 },
      fromCache: false,
    });
    expect(Date.parse(res.body.cachedAt)).not.toBeNaN();
    // finishedAt은 넣은 시각 그대로(DB datetime ↔ UTC ISO 변환이 시간대만큼 밀리지 않는다 — 초 미만은 잘릴 수 있어 1초 안)
    expect(Math.abs(Date.parse(res.body.van.finishedAt) - vanFinishedAt)).toBeLessThan(1_000);
  });

  it('두 번째 요청은 캐시(같은 cachedAt). 캐시가 살아 있는 동안은 데이터가 바뀌어도 옛 값, refresh=true면 다시 집계한다', async () => {
    const first = (await get()).body;
    const ttl = await redis.pttl(dashboardCacheKey());
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(env.dashboardCacheTtlMs);

    await insertTerminals(t, [{ serialNo: 'DB-07', status: S.IN_STOCK }]);
    const second = (await get()).body;
    expect(second).toMatchObject({ fromCache: true, cachedAt: first.cachedAt });
    expect(second.terminals.total).toBe(6);

    const refreshed = (await get({ refresh: 'true' })).body;
    expect(refreshed.fromCache).toBe(false);
    expect(refreshed.terminals.total).toBe(7);
    expect((await get()).body).toMatchObject({ fromCache: true, cachedAt: refreshed.cachedAt });
  });

  it('캐시가 빈 상태에서 동시 요청 5개는 집계를 한 번만 한다(single-flight)', async () => {
    const log = captureQueries(t.orm);
    let bodies;
    try {
      bodies = (await Promise.all(Array.from({ length: 5 }, () => get()))).map((r) => r.body);
    } finally {
      log.stop();
    }
    expect(log.queries.filter((q) => /from `?terminal_status_history`?/i.test(q))).toHaveLength(1);
    expect(new Set(bodies.map((b) => b.cachedAt)).size).toBe(1);
  });

  describe('새로고침과 진행 중 집계(리뷰 반영)', () => {
    let svc: DashboardService;
    let queries: DashboardQueries;
    let real: DashboardQueries['collect'];
    /** 집계 호출 수와, 첫 집계를 붙잡아 두는 문 */
    let calls = 0;
    let release: () => void = () => {};
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    /** collect를 감싼다: 호출을 세고, holdFirst면 첫 호출을 release()까지 멈춘다 */
    function spyCollect(holdFirst: boolean) {
      calls = 0;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      return vi.spyOn(queries, 'collect').mockImplementation(async (now?: Date) => {
        calls += 1;
        if (holdFirst && calls === 1) await gate;
        return real(now);
      });
    }

    beforeAll(() => {
      svc = t.app.get(DashboardService);
      queries = t.app.get(DashboardQueries);
      real = queries.collect.bind(queries);
    });

    it('일반 집계가 도는 중 refresh는 그 집계에 합류하지 않고 새로 집계한다', async () => {
      const spy = spyCollect(true);
      try {
        const normal = svc.summary();
        await vi.waitFor(() => expect(calls).toBe(1));
        await sleep(5);
        const refreshing = svc.summary({ refresh: true });
        await vi.waitFor(() => expect(calls).toBe(2));
        const refreshed = await refreshing;
        release();
        const old = await normal;
        expect(refreshed.fromCache).toBe(false);
        expect(Date.parse(refreshed.cachedAt)).toBeGreaterThan(Date.parse(old.cachedAt));
      } finally {
        release();
        spy.mockRestore();
      }
    });

    it('늦게 끝난 옛 집계가 새로고침 결과를 캐시에서 덮어쓰지 않는다', async () => {
      const spy = spyCollect(true);
      try {
        const normal = svc.summary();
        await vi.waitFor(() => expect(calls).toBe(1));
        await sleep(5);
        const refreshing = svc.summary({ refresh: true });
        await vi.waitFor(() => expect(calls).toBe(2));
        const refreshed = await refreshing;
        release();
        await normal;
        expect((await svc.summary()).cachedAt).toBe(refreshed.cachedAt);
      } finally {
        release();
        spy.mockRestore();
      }
    });

    it('동시에 온 refresh 둘은 집계 하나를 함께 쓴다', async () => {
      const spy = spyCollect(false);
      try {
        const [a, b] = await Promise.all([svc.summary({ refresh: true }), svc.summary({ refresh: true })]);
        expect(calls).toBe(1);
        expect(a.cachedAt).toBe(b.cachedAt);
      } finally {
        spy.mockRestore();
      }
    });

    it('refresh 집계가 도는 중 캐시가 빈 일반 요청은 그 refresh에 합류한다(더 새로운 값)', async () => {
      const spy = spyCollect(true);
      try {
        const refreshing = svc.summary({ refresh: true });
        await vi.waitFor(() => expect(calls).toBe(1));
        const normal = svc.summary();
        await sleep(20);
        release();
        const [r, n] = await Promise.all([refreshing, normal]);
        expect(calls).toBe(1);
        expect(n.cachedAt).toBe(r.cachedAt);
      } finally {
        release();
        spy.mockRestore();
      }
    });

    it('집계가 실패하면 진행 중 표시를 비워 다음 요청은 다시 집계한다', async () => {
      const spy = vi.spyOn(queries, 'collect').mockRejectedValueOnce(new Error('집계 실패(테스트)'));
      try {
        await expect(svc.summary()).rejects.toThrow('집계 실패(테스트)');
        const ok = await svc.summary();
        expect(ok.terminals.total).toBeGreaterThan(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('Redis 읽기·쓰기가 실패해도 캐시 없이 집계해 200', async () => {
      const get = vi.spyOn(redis, 'get').mockRejectedValueOnce(new Error('redis down(테스트)'));
      const set = vi.spyOn(redis, 'set').mockRejectedValueOnce(new Error('redis down(테스트)'));
      try {
        const res = await t.http().get('/dashboard/summary');
        expect(res.status).toBe(200);
        expect(res.body.fromCache).toBe(false);
        expect(get).toHaveBeenCalled();
        expect(set).toHaveBeenCalled();
      } finally {
        get.mockRestore();
        set.mockRestore();
      }
    });
  });

  it('refresh는 true·false만(그 밖은 400)', async () => {
    expect((await get({ refresh: 'yes' })).status).toBe(400);
    expect((await get({ refresh: 'false' })).status).toBe(200);
  });
});
