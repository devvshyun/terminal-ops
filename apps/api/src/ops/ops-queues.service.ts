import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { EntityManager } from '@mikro-orm/mysql';
import type { OpsDependencyView, OpsQueueView, OpsQueuesView, OpsSchedulerView, OpsSystemView, OpsWorkerView } from '@terminal-ops/contracts';
import { env } from '../config/env.js';
import { ALL_QUEUES, QUEUE, type QueueName } from '../queue/queue-names.js';
import { REDIS } from '../redis/redis.provider.js';
import { JOB_SCHEDULERS } from '../scheduler/job-schedulers.js';
import { recentCount } from './queue-metrics.js';
import { OpsTimeoutError, withTimeout } from './with-timeout.js';

/** 관제 읽기가 Redis(BullMQ·ping)를 기다리는 최대 시간(Task 1 리뷰 반영, decisions/0071) */
export const OPS_REDIS_TIMEOUT_MS = 2000;

/** 처리량을 보는 창(분). 화면 카드의 "최근 15분" */
export const RECENT_MINUTES = 15;

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

/**
 * 의존 오류를 화면에 보일 짧은 글로 — 이름과 코드만(`Error ECONNREFUSED`, `TIMEOUT`). 메시지는 보내지 않는다:
 * 연결 오류 메시지에는 호스트·포트가 들어간다(`connect ECONNREFUSED 10.0.0.5:6379`, Task 1 리뷰 반영)
 */
function errorLabel(error: unknown): string {
  if (!(error instanceof Error)) return 'Error';
  const code = (error as { code?: unknown }).code;
  return (typeof code === 'string' || typeof code === 'number' ? `${error.name} ${code}` : error.name).slice(0, 100);
}

/** BullMQ getWorkers()의 rawname `<접두사>:<큐 base64>:w:<워커 이름>`에서 워커 이름. 이름 없이 뜬 워커는 null */
export function workerNameOf(rawname: string | undefined): string | null {
  const at = rawname?.lastIndexOf(':w:') ?? -1;
  return at >= 0 ? rawname!.slice(at + 3) || null : null;
}

/**
 * 운영 관제의 읽기(보강 6, decisions/0070·0071): 큐 요약, 주기 작업, 프로세스·의존 상태.
 * 큐마다 Redis 명령 몇 개(getJobCounts·isPaused·getJobs·getMetrics×2·getWorkers)라 6개 큐를 한 번에 Promise.all로 읽는다.
 */
@Injectable()
export class OpsQueuesService {
  private readonly queues: Record<QueueName, Queue>;
  /** Redis를 기다리는 최대 시간(테스트가 줄인다) */
  timeoutMs = OPS_REDIS_TIMEOUT_MS;

  constructor(
    private readonly em: EntityManager,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectQueue(QUEUE.TRACK_BUNGAE) bungae: Queue,
    @InjectQueue(QUEUE.TRACK_NEURIMBO) neurimbo: Queue,
    @InjectQueue(QUEUE.CARRIER_SWEEP) sweep: Queue,
    @InjectQueue(QUEUE.OUTBOX) outbox: Queue,
    @InjectQueue(QUEUE.DEVICE) device: Queue,
    @InjectQueue(QUEUE.REPORT) report: Queue,
  ) {
    this.queues = {
      [QUEUE.TRACK_BUNGAE]: bungae,
      [QUEUE.TRACK_NEURIMBO]: neurimbo,
      [QUEUE.CARRIER_SWEEP]: sweep,
      [QUEUE.OUTBOX]: outbox,
      [QUEUE.DEVICE]: device,
      [QUEUE.REPORT]: report,
    };
  }

  /** 이름으로 큐. 없는 이름은 404(경로 :name) */
  queue(name: string): Queue {
    if (!(ALL_QUEUES as string[]).includes(name)) throw new NotFoundException(`없는 큐입니다: ${name}`);
    return this.queues[name as QueueName];
  }

  /**
   * Redis 읽기를 시간 제한 안에서. 제한에 걸리면 503 — 화면은 "잠시 뒤 다시"로 보이고 10초 뒤 다시 부른다(decisions/0076).
   * 읽기에만 쓴다: 다시 시도·지우기 같은 쓰기에 걸면 제한 뒤에 작업이 끝나 감사 기록 없이 바뀔 수 있다.
   */
  async read<T>(p: Promise<T>, what: string): Promise<T> {
    try {
      return await withTimeout(p, this.timeoutMs, what);
    } catch (error) {
      if (error instanceof OpsTimeoutError) throw new ServiceUnavailableException(`Redis가 ${this.timeoutMs}ms 안에 답하지 않습니다(${what}). 잠시 뒤 다시 보세요`);
      throw error;
    }
  }

  async summary(now = Date.now()): Promise<OpsQueuesView> {
    const queues = await this.read(Promise.all(ALL_QUEUES.map((name) => this.queueView(name, now))), '큐 요약');
    return { checkedAt: new Date(now).toISOString(), recentMinutes: RECENT_MINUTES, queues };
  }

  private async queueView(name: QueueName, now: number): Promise<OpsQueueView> {
    const q = this.queues[name];
    const [counts, paused, oldest, completed, failed, workers] = await Promise.all([
      q.getJobCounts('waiting', 'active', 'delayed', 'prioritized', 'failed', 'completed'),
      q.isPaused(),
      // waiting은 LPUSH 목록이라 asc=true의 첫 칸이 가장 오래된 job(사전 검증)
      q.getJobs(['waiting'], 0, 0, true),
      q.getMetrics('completed', 0, RECENT_MINUTES),
      q.getMetrics('failed', 0, RECENT_MINUTES),
      q.getWorkersCount(),
    ]);
    return {
      name,
      counts: {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        prioritized: counts.prioritized ?? 0,
        failed: counts.failed ?? 0,
        completed: counts.completed ?? 0,
      },
      paused,
      oldestWaitingAt: iso(oldest[0]?.timestamp),
      completedRecent: recentCount(completed, now, RECENT_MINUTES),
      failedRecent: recentCount(failed, now, RECENT_MINUTES),
      workers,
    };
  }

  /** 코드의 주기 작업 목록 + Redis에 등록된 것(목록에 없는 것은 defined false로 뒤에) */
  async schedulers(): Promise<OpsSchedulerView[]> {
    const registered = new Map<string, { queue: QueueName; s: Awaited<ReturnType<Queue['getJobSchedulers']>>[number] }>();
    const lists = await this.read(Promise.all(ALL_QUEUES.map((name) => this.queues[name].getJobSchedulers(0, -1, true))), '주기 작업');
    ALL_QUEUES.forEach((name, i) => {
      for (const s of lists[i]) registered.set(`${name}/${s.key}`, { queue: name, s });
    });
    const rows: OpsSchedulerView[] = [];
    for (const def of JOB_SCHEDULERS) {
      const found = registered.get(`${def.queue}/${def.id}`);
      registered.delete(`${def.queue}/${def.id}`);
      const schedule = found ? { every: found.s.every ?? null, pattern: found.s.pattern ?? null, tz: found.s.tz ?? null } : this.fromDefinition(def.schedule());
      rows.push({ id: def.id, queue: def.queue, jobName: def.jobName, ...schedule, defined: true, registered: !!found, nextRunAt: iso(found?.s.next) });
    }
    for (const { queue, s } of registered.values()) {
      rows.push({ id: s.key, queue, jobName: s.name, every: s.every ?? null, pattern: s.pattern ?? null, tz: s.tz ?? null, defined: false, registered: true, nextRunAt: iso(s.next) });
    }
    return rows;
  }

  private fromDefinition(s: { every: number } | { pattern: string; tz: string }) {
    return 'every' in s ? { every: s.every, pattern: null, tz: null } : { every: null, pattern: s.pattern, tz: s.tz };
  }

  async system(now = Date.now()): Promise<OpsSystemView> {
    const [mysql, redis, workers] = await Promise.all([
      this.ping(() => this.em.getConnection().execute('select 1')),
      this.ping(() => this.redis.ping()),
      // 워커 목록을 못 읽으면(Redis가 느림·죽음) 빈 목록 — 그때는 redis가 ok:false로 함께 보인다(decisions/0071 대가)
      withTimeout(this.workers(), this.timeoutMs, '워커 목록').catch((): OpsWorkerView[] => []),
    ]);
    return {
      checkedAt: new Date(now).toISOString(),
      api: {
        version: env.appVersion,
        startedAt: new Date(now - Math.round(process.uptime() * 1000)).toISOString(),
        node: process.version,
        queuePrefix: env.queuePrefix,
        runWorkers: env.runWorkers,
        runSchedulers: env.runSchedulers,
      },
      mysql,
      redis,
      workers,
    };
  }

  private async ping(run: () => Promise<unknown>): Promise<OpsDependencyView> {
    const started = performance.now();
    try {
      await withTimeout(run(), this.timeoutMs, 'ping');
      return { ok: true, latencyMs: Math.round((performance.now() - started) * 10) / 10, error: null };
    } catch (error) {
      return { ok: false, latencyMs: null, error: errorLabel(error) };
    }
  }

  /**
   * 큐마다 워커 연결(Redis CLIENT LIST의 연결 이름). CLIENT 명령을 막은 Redis(일부 관리형)면 BullMQ가 이름 없는 항목 하나
   * (`{ name: 'GCP does not support client list' }`)를 준다 — 이름 없는 워커 1로 보인다(decisions/0071 대가). 이 프로젝트의 Docker Redis는 된다
   */
  private async workers(): Promise<OpsWorkerView[]> {
    const lists = await Promise.all(
      ALL_QUEUES.map(async (name) => (await this.queues[name].getWorkers()).map((w) => ({ queue: name, name: workerNameOf(w.rawname), idleSeconds: Number(w.idle) || 0 }))),
    );
    return lists.flat();
  }
}
