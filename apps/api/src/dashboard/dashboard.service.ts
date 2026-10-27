import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { DashboardView } from '@terminal-ops/contracts';
import { env } from '../config/env.js';
import { REDIS } from '../redis/redis.provider.js';
import { DashboardQueries } from './dashboard.queries.js';

/** 화면에 주는 값: 집계 + 그 집계를 만든 시각(cachedAt)과 이번 응답이 캐시에서 왔는지(contracts DashboardView) */
export type { DashboardView };

/** 캐시 키. 큐와 같은 접두사라 테스트(test-…)와 개발(terminal-ops)이 섞이지 않는다 */
export const dashboardCacheKey = () => `${env.queuePrefix}:dash:summary`;

/**
 * 대시보드(어드민 처음 화면) 집계와 Redis 캐시(설계안 5장 Redis ⑤, decisions/0044).
 * - 캐시: 집계 결과 JSON을 TTL(DASHBOARD_CACHE_TTL_MS, 기본 30초)로 둔다. 전이마다 지우지 않는다 — 화면이 "N초 전 기준"을 보여 주고,
 *   운영자가 새로고침(refresh)하면 캐시를 건너뛰고 다시 집계해 덮어쓴다.
 * - 동시에 캐시가 비었을 때: 이 프로세스 안에서는 집계 하나만 돌고 나머지는 그 결과를 기다린다(single-flight). 프로세스가 여럿이면
 *   프로세스마다 한 번씩 돈다(Redis 잠금을 두지 않는다 — api 프로세스는 한두 개).
 * - 새로고침은 진행 중인 일반 집계에 합류하지 않는다(그 집계는 새로고침을 누르기 전에 시작한 것이라 옛 값일 수 있다). 동시에 온
 *   새로고침끼리는 집계 하나를 함께 쓰고, 그동안 캐시가 빈 일반 요청은 그 새로고침에 합류한다(더 새로운 값이라 손해가 없다).
 * - 늦게 끝난 옛 집계는 더 나중에 시작한 집계가 이미 쓴 캐시를 덮지 않는다(이 프로세스 안에서만 — cachedAt = 집계 시작 시각).
 * - Redis가 실패하면 캐시 없이 집계해 준다(대시보드가 Redis 때문에 멈추지 않게). 경고만 남긴다.
 */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);
  /** 지금 도는 일반 집계(single-flight). 끝나면 비운다 */
  private inflight: Promise<DashboardView> | null = null;
  /** 지금 도는 새로고침 집계. 동시에 온 새로고침끼리만 묶는다 */
  private refreshInflight: Promise<DashboardView> | null = null;
  /** 이 프로세스가 캐시에 마지막으로 쓴 집계의 시작 시각(ms). 이보다 먼저 시작한 집계는 캐시에 쓰지 않는다 */
  private lastWrittenAt = 0;

  constructor(
    private readonly queries: DashboardQueries,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * @param opts.refresh true면 캐시를 읽지 않고 다시 집계해 캐시를 덮어쓴다(화면의 새로고침)
   * @param opts.cache false면 캐시를 읽지도 쓰지도 않는다(실험 0015의 "캐시 없음" 비교용, 실험 0013의 strategy 인자처럼 운영 코드는 기본값)
   * @param opts.singleFlight false면 동시 미스를 묶지 않는다(실험 0015 비교용)
   */
  async summary(opts: { refresh?: boolean; cache?: boolean; singleFlight?: boolean } = {}): Promise<DashboardView> {
    const useCache = opts.cache ?? true;
    if (useCache && !opts.refresh) {
      const cached = await this.readCache();
      if (cached) return { ...cached, fromCache: true };
    }
    if (opts.singleFlight === false) return this.compute(useCache);
    if (opts.refresh) {
      this.refreshInflight ??= this.compute(useCache).finally(() => {
        this.refreshInflight = null;
      });
      return this.refreshInflight;
    }
    if (this.refreshInflight) return this.refreshInflight;
    this.inflight ??= this.compute(useCache).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async compute(writeCache: boolean): Promise<DashboardView> {
    const now = new Date();
    const view: DashboardView = { ...(await this.queries.collect(now)), cachedAt: now.toISOString(), fromCache: false };
    if (writeCache && now.getTime() >= this.lastWrittenAt) {
      this.lastWrittenAt = now.getTime();
      try {
        await this.redis.set(dashboardCacheKey(), JSON.stringify(view), 'PX', env.dashboardCacheTtlMs);
      } catch (error) {
        this.logger.warn(`대시보드 캐시 쓰기 실패(캐시 없이 응답): ${(error as Error).message}`);
      }
    }
    return view;
  }

  private async readCache(): Promise<DashboardView | null> {
    try {
      const raw = await this.redis.get(dashboardCacheKey());
      return raw ? (JSON.parse(raw) as DashboardView) : null;
    } catch (error) {
      this.logger.warn(`대시보드 캐시 읽기 실패(다시 집계): ${(error as Error).message}`);
      return null;
    }
  }
}
