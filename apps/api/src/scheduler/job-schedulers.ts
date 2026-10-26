import type { Queue } from 'bullmq';
import { CRON_TZ } from '../config/env-cron.js';
import { env } from '../config/env.js';
import { QUEUE, type QueueName } from '../queue/queue-names.js';

/** cron 주기 작업의 시간대. 서버 시간대와 상관없이 한국 시간으로 돈다(decisions/0035). env의 cron 검증과 같은 값 */
export const SCHEDULE_TZ = CRON_TZ;

/** 주기: 간격(ms) 또는 cron 식 + 시간대. BullMQ upsertJobScheduler의 repeat 옵션에 그대로 넘긴다 */
export type JobSchedule = { every: number } | { pattern: string; tz: string };

/**
 * 주간 리포트 job만 BullMQ 재시도: 실패하면 다음 주까지 다시 돌지 않기 때문(Task 8 리뷰, decisions/0035).
 * 1·2·4·8분(합 15분) — 프로세스가 죽어 남은 보내기 잠금(weeklyReportLockTtlMs, 기본 약 10.6분)이 풀린 뒤에도 재시도가 남는다.
 * 보내기는 주마다 멱등(SENT면 건너뜀)이라 다시 돌아도 같은 주를 두 번 보내지 않는다.
 */
export const WEEKLY_REPORT_JOB_OPTS = { attempts: 5, backoff: { type: 'exponential', delay: 60_000 } } as const;

/** 주기 작업 목록. 등록(SchedulerService)과 삭제(scheduler:clear)가 같은 id를 쓴다. schedule은 등록할 때 읽는다. */
export const JOB_SCHEDULERS = [
  { queue: QUEUE.CARRIER_SWEEP, id: 'carrier-sweep', jobName: 'sweep', schedule: () => ({ every: env.sweepIntervalMs }) },
  { queue: QUEUE.OUTBOX, id: 'outbox-relay', jobName: 'relay', schedule: () => ({ every: env.relayIntervalMs }) },
  { queue: QUEUE.DEVICE, id: 'active-rebuild', jobName: 'rebuild-active', schedule: () => ({ every: env.activeRebuildIntervalMs }) },
  { queue: QUEUE.DEVICE, id: 'offline-detect', jobName: 'detect-offline', schedule: () => ({ every: env.offlineDetectIntervalMs }) },
  { queue: QUEUE.DEVICE, id: 'connectivity-snapshot', jobName: 'snapshot', schedule: () => ({ every: env.connectivitySnapshotIntervalMs }) },
  { queue: QUEUE.DEVICE, id: 'rollout-control', jobName: 'rollout-control', schedule: () => ({ every: env.rolloutControlIntervalMs }) },
  // 매일 밤(KST): 이상 단말기 찾기(F4), VAN 등록 대조(F9). report 큐(concurrency 1)라 둘이 겹치지 않는다
  { queue: QUEUE.REPORT, id: 'anomaly-scan-daily', jobName: 'anomaly-scan', schedule: () => ({ pattern: env.anomalyScanCron, tz: SCHEDULE_TZ }) },
  { queue: QUEUE.REPORT, id: 'van-reconcile-daily', jobName: 'van-reconcile-scheduled', schedule: () => ({ pattern: env.vanReconcileCron, tz: SCHEDULE_TZ }) },
  // 매주 월요일 09:00 KST: 지난주 운영 리포트(F11)
  {
    queue: QUEUE.REPORT,
    id: 'weekly-report',
    jobName: 'weekly-report',
    schedule: () => ({ pattern: env.weeklyReportCron, tz: SCHEDULE_TZ }),
    jobOpts: WEEKLY_REPORT_JOB_OPTS,
  },
] as const satisfies readonly { queue: QueueName; id: string; jobName: string; schedule: () => JobSchedule; jobOpts?: { attempts: number; backoff: { type: string; delay: number } } }[];

/** 로그용: `1000ms` 또는 `cron "0 2 * * *" Asia/Seoul` */
export function describeSchedule(s: JobSchedule): string {
  return 'every' in s ? `${s.every}ms` : `cron "${s.pattern}" ${s.tz}`;
}

/**
 * 주기 작업을 Redis에서 지운다. job scheduler는 등록한 프로세스가 끝나도 Redis에 남아 계속 job을 만든다
 * (Day 2 리뷰 Minor 2, decisions/0015). 다음 주기 job(delayed)도 함께 지워진다.
 * @returns 지운 scheduler id 목록(없던 것은 빠진다)
 */
export async function clearJobSchedulers(queueOf: (name: QueueName) => Queue): Promise<string[]> {
  const removed: string[] = [];
  for (const s of JOB_SCHEDULERS) {
    if (await queueOf(s.queue).removeJobScheduler(s.id)) removed.push(s.id);
  }
  return removed;
}
