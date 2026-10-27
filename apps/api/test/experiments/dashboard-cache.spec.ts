import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DashboardQueries } from '../../src/dashboard/dashboard.queries.js';
import { dashboardCacheKey, DashboardService, type DashboardView } from '../../src/dashboard/dashboard.service.js';
import { REDIS } from '../../src/redis/redis.provider.js';
import { seedFleet } from '../helpers/fleet-seed.js';
import { captureQueries } from '../helpers/query-log.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

/**
 * 실험 0015: 대시보드 집계 캐시 전후(설계안 7장 "대시보드 캐시 전후 p50/p95", decisions/0044).
 * 단말기 10만·이력 약 100만(실험 0011의 시드 식, test/helpers/fleet-seed.ts)에서
 * ① 요청 하나: 캐시 없음(매번 집계) 대 캐시 적중 — 서비스 호출 p50·p95, HTTP(적중 / refresh=true = 다시 집계) p50·p95
 * ② 집계 쿼리 일곱 개의 DB 왕복 시간(MikroORM context.took)
 * ③ 동시 요청 C개(기본 50): 캐시 없음 / 캐시 있음·동시 미스 묶지 않음 / 캐시 있음·single-flight(지금 코드) / 캐시 적중 /
 *    새로고침 C개(새로고침끼리 묶음) — MySQL로 간 쿼리 수, 전체 시간, 요청별 p50·p95
 * ④ 빈 캐시에 일반 C/2개가 도는 중 새로고침 C/2개(Task 3 리뷰 반영: 새로고침은 진행 중 일반 집계에 합류하지 않는다) —
 *    집계 수, 두 묶음의 cachedAt, 끝난 뒤 캐시에 남은 값
 * 재현: EXPERIMENTS=1 npx vitest run test/experiments/dashboard-cache.spec.ts --silent=false
 * 바꾸기: EXP_TERMINALS=100000, EXP_RUNS=20, EXP_CONCURRENCY=50. 끝나면 캐시 키를 지우고 테스트 DB를 resetDatabase로 다시 만든다(빈 표 + 참조 데이터).
 */
const N = Number(process.env.EXP_TERMINALS ?? 100_000);
const RUNS = Number(process.env.EXP_RUNS ?? 20);
const C = Number(process.env.EXP_CONCURRENCY ?? 50);

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))];
const round = (x: number) => Math.round(x * 10) / 10;
const stats = (xs: number[]) => ({ p50: round(pct(xs, 50)), p95: round(pct(xs, 95)), min: round(Math.min(...xs)), max: round(Math.max(...xs)) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe(`실험 0015 — 대시보드 캐시 (단말기 ${N}대)`, () => {
  let t: TestApp;
  let svc: DashboardService;
  let redis: Redis;
  const clearCache = () => redis.del(dashboardCacheKey());

  async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; res: T }> {
    const start = performance.now();
    const res = await fn();
    return { ms: performance.now() - start, res };
  }

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    svc = t.app.get(DashboardService);
    redis = t.app.get<Redis>(REDIS);
    await clearCache();
    const [env] = (await t.orm.em.fork().execute('select version() as v, @@innodb_buffer_pool_size as bp')) as { v: string; bp: unknown }[];
    console.log(`[실험 0015] MySQL ${env.v}, innodb_buffer_pool_size ${Math.round(Number(env.bp) / 1024 / 1024)}MB, Node ${process.version}`);
    const base = new Date(Math.floor(Date.now() / 60_000) * 60_000); // 분 단위로 자른 지금(이번 주 전이가 생기게)
    const seeded = await seedFleet(t, { terminals: N, base });
    console.log(`[실험 0015] 시드 ${JSON.stringify(seeded)}`);
  }, 600_000);
  afterAll(async () => {
    if (!t) return;
    try {
      await clearCache();
      await resetDatabase(t.orm);
      const [left] = (await t.orm.em.fork().execute(
        'select (select count(*) from terminal) as terminals, (select count(*) from terminal_status_history) as history',
      )) as { terminals: unknown; history: unknown }[];
      console.log(`[실험 0015] 정리 뒤 terminal ${Number(left.terminals)}행, 이력 ${Number(left.history)}행, 캐시 키 ${await redis.exists(dashboardCacheKey())}개`);
    } finally {
      await t.app.close();
    }
  }, 120_000);

  it('요청 하나: 캐시 없음 대 적중, 쿼리별 시간', async () => {
    // 데우기(버퍼 풀·연결)
    await svc.summary({ cache: false });
    const noCache: number[] = [];
    for (let i = 0; i < RUNS; i++) noCache.push((await timed(() => svc.summary({ cache: false }))).ms);
    await clearCache();
    const first = await svc.summary();
    const hit: number[] = [];
    let last!: DashboardView;
    for (let i = 0; i < RUNS; i++) {
      const r = await timed(() => svc.summary());
      hit.push(r.ms);
      last = r.res;
    }
    expect(first.fromCache).toBe(false);
    expect(last.fromCache).toBe(true);

    const httpHit: number[] = [];
    const httpRefresh: number[] = [];
    await t.http().get('/dashboard/summary');
    for (let i = 0; i < RUNS; i++) httpHit.push((await timed(() => t.http().get('/dashboard/summary'))).ms);
    for (let i = 0; i < RUNS; i++) httpRefresh.push((await timed(() => t.http().get('/dashboard/summary').query({ refresh: 'true' }))).ms);

    // 쿼리별 DB 왕복 시간(5번 중 중앙값)
    const queries = t.app.get(DashboardQueries);
    const per: Record<string, number[]> = {};
    for (let i = 0; i < 5; i++) {
      const log = captureQueries(t.orm);
      try {
        await queries.collect();
      } finally {
        log.stop();
      }
      log.queries.forEach((q, j) => {
        if (/^(begin|commit|set transaction|start transaction)/i.test(q)) return;
        const name = q.replace(/\s+/g, ' ').slice(0, 70);
        (per[name] ??= []).push(log.took[j]);
      });
    }
    const perQuery = Object.entries(per).map(([q, ms]) => `${round(pct(ms, 50))}ms ${q}`);
    const bytes = JSON.stringify(last).length;
    console.log(
      `[실험 0015 ①] 서비스 캐시 없음 ${JSON.stringify(stats(noCache))} / 캐시 적중 ${JSON.stringify(stats(hit))} / ` +
        `HTTP 적중 ${JSON.stringify(stats(httpHit))} / HTTP refresh=true ${JSON.stringify(stats(httpRefresh))} / 응답 JSON ${bytes}바이트 / ` +
        `값: 단말기 ${last.terminals.total}, 운영 중 ${last.connectivity.inService}, 열린 이상 ${last.anomalies.open}, 이번 주 전이 ${last.week.transitions}(${last.week.weekStart}~)`,
    );
    console.log(`[실험 0015 ②] 쿼리별 DB 왕복(중앙값, 5번)\n  ${perQuery.join('\n  ')}`);
  }, 600_000);

  it(`동시 요청 ${C}개: 캐시 없음 / 캐시·묶지 않음 / 캐시·single-flight / 캐시 적중 / 새로고침 — MySQL 쿼리 수와 시간`, async () => {
    const variants: { name: string; opts: Parameters<DashboardService['summary']>[0]; warm: boolean }[] = [
      // 캐시 없음 = 묶지도 않음(cache: false만 주면 기본값 single-flight가 켜져 집계가 한 번으로 묶인다 — 사전 검증 첫 실행의 실수)
      { name: '캐시 없음', opts: { cache: false, singleFlight: false }, warm: false },
      { name: '캐시·동시 미스 묶지 않음(빈 캐시)', opts: { singleFlight: false }, warm: false },
      { name: '캐시·single-flight(빈 캐시, 지금 코드)', opts: {}, warm: false },
      { name: '캐시 적중', opts: {}, warm: true },
      { name: '새로고침 동시(캐시 찬 상태, 새로고침끼리 묶음)', opts: { refresh: true }, warm: true },
    ];
    const lines: string[] = [];
    for (const v of variants) {
      await clearCache();
      if (v.warm) await svc.summary();
      const log = captureQueries(t.orm);
      let each: number[] = [];
      let wall = 0;
      try {
        const start = performance.now();
        each = await Promise.all(Array.from({ length: C }, async () => (await timed(() => svc.summary(v.opts))).ms));
        wall = performance.now() - start;
      } finally {
        log.stop();
      }
      const sql = log.queries.filter((q) => /^select /i.test(q)).length;
      const historyScans = log.queries.filter((q) => /from `?terminal_status_history`?/i.test(q)).length;
      lines.push(`${v.name}: SELECT ${sql}개(이력 훑기 ${historyScans}번), 전체 ${round(wall)}ms, 요청별 ${JSON.stringify(stats(each))}`);
    }
    console.log(`[실험 0015 ③] 동시 ${C}개\n  ${lines.join('\n  ')}`);
  }, 600_000);

  it(`빈 캐시에 일반 ${C / 2}개가 도는 중 새로고침 ${C / 2}개 — 새로고침은 합류하지 않고 따로 한 번`, async () => {
    const half = Math.floor(C / 2);
    await clearCache();
    const log = captureQueries(t.orm);
    let normal: { ms: number; res: DashboardView }[] = [];
    let refresh: { ms: number; res: DashboardView }[] = [];
    let refreshDelay = 0;
    try {
      const started = performance.now();
      const normalP = Promise.all(Array.from({ length: half }, () => timed(() => svc.summary())));
      await sleep(20); // 일반 집계가 시작된 뒤(집계 한 번은 100ms대)
      refreshDelay = performance.now() - started;
      const refreshP = Promise.all(Array.from({ length: half }, () => timed(() => svc.summary({ refresh: true }))));
      [normal, refresh] = await Promise.all([normalP, refreshP]);
    } finally {
      log.stop();
    }
    const historyScans = log.queries.filter((q) => /from `?terminal_status_history`?/i.test(q)).length;
    const sql = log.queries.filter((q) => /^select /i.test(q)).length;
    const nAt = new Set(normal.map((r) => r.res.cachedAt));
    const rAt = new Set(refresh.map((r) => r.res.cachedAt));
    const cached = await svc.summary();
    console.log(
      `[실험 0015 ④] 일반 ${half}개 시작 ${round(refreshDelay)}ms 뒤 새로고침 ${half}개: SELECT ${sql}개(이력 훑기 ${historyScans}번), ` +
        `일반 cachedAt ${[...nAt].join(',')} 요청별 ${JSON.stringify(stats(normal.map((r) => r.ms)))} / ` +
        `새로고침 cachedAt ${[...rAt].join(',')} 요청별 ${JSON.stringify(stats(refresh.map((r) => r.ms)))} / ` +
        `끝난 뒤 캐시 cachedAt ${cached.cachedAt}(fromCache ${cached.fromCache})`,
    );
    expect(historyScans).toBe(2);
    expect(nAt.size).toBe(1);
    expect(rAt.size).toBe(1);
    expect(Date.parse([...rAt][0])).toBeGreaterThan(Date.parse([...nAt][0]));
    expect(cached).toMatchObject({ fromCache: true, cachedAt: [...rAt][0] });
  }, 600_000);
});
