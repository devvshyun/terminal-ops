import { Injectable, NotFoundException } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { OpsFailedJobsPage, OpsFailedJobView, OpsJobActionResult, OpsQueueName } from '@terminal-ops/contracts';
import type { Principal } from '../auth/principal.js';
import { BusinessError } from '../common/domain-errors.js';
import { redactJobData, shortReason } from './job-data.js';
import { OpsAuditService } from './ops-audit.service.js';
import { OpsQueuesService } from './ops-queues.service.js';

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

export function toFailedJobView(queue: OpsQueueName, job: Job): OpsFailedJobView {
  return {
    queue,
    id: String(job.id),
    name: job.name,
    data: redactJobData(job.data),
    failedReason: shortReason(job.failedReason),
    attemptsMade: job.attemptsMade,
    maxAttempts: job.opts.attempts ?? 1,
    createdAt: new Date(job.timestamp).toISOString(),
    failedAt: iso(job.finishedOn),
  };
}

/**
 * 실패 job 보기·다시 시도·지우기(보강 6, decisions/0072·0073).
 * 다시 시도·지우기는 지금 failed 상태인 job만 — 없으면 404, 실패 상태가 아니면(이미 다시 시도함·처리 중·지워짐) 409 JOB_NOT_FAILED.
 * 성공하면 감사 기록을 남긴다(누가·언제·어느 큐의 어느 job·그때의 실패 이유).
 */
@Injectable()
export class OpsJobsService {
  constructor(
    private readonly queues: OpsQueuesService,
    private readonly audit: OpsAuditService,
  ) {}

  /** 최근 실패부터(BullMQ getFailed는 끝난 시각 내림차순) start번째부터 limit개 */
  async listFailed(name: string, start: number, limit: number): Promise<OpsFailedJobsPage> {
    const q = this.queues.queue(name);
    const [jobs, total] = await Promise.all([q.getFailed(start, start + limit - 1), q.getFailedCount()]);
    return { items: jobs.filter(Boolean).map((j) => toFailedJobView(name as OpsQueueName, j)), total, start, limit };
  }

  /**
   * 실패한 job을 다시 대기열로. 시도 횟수를 0으로 되돌린다 — 그 job의 재시도 규칙(attempts·backoff)이 처음부터 다시 적용된다
   * (되돌리지 않으면 attempts를 다 쓴 job은 한 번만 돌고 바로 실패한다, decisions/0072).
   */
  async retry(name: string, jobId: string, who: Principal): Promise<OpsJobActionResult> {
    const job = await this.failedJob(name, jobId);
    // 기록할 사정은 다시 시도 전에 읽는다 — retry 직후 이 job 객체의 failedReason이 비었다(사전 검증, decisions/0072)
    const detail = this.detailOf(job);
    try {
      await job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
    } catch (error) {
      // 확인과 다시 시도 사이에 다른 사람이 먼저 다시 시도·지웠다(BullMQ: Missing key / not in failed state)
      throw await this.notFailedAfterRace(name, jobId, error);
    }
    const row = await this.audit.record(who, 'RETRY_JOB', { queue: name, jobId, jobName: job.name, detail });
    return { queue: name as OpsQueueName, jobId, action: 'RETRY_JOB', actionId: row.id };
  }

  /** 실패한 job을 Redis에서 지운다(되돌릴 수 없다 — 화면은 확인창을 띄운다) */
  async remove(name: string, jobId: string, who: Principal): Promise<OpsJobActionResult> {
    const job = await this.failedJob(name, jobId);
    const detail = this.detailOf(job);
    try {
      await job.remove();
    } catch (error) {
      throw await this.notFailedAfterRace(name, jobId, error);
    }
    const row = await this.audit.record(who, 'REMOVE_JOB', { queue: name, jobId, jobName: job.name, detail });
    return { queue: name as OpsQueueName, jobId, action: 'REMOVE_JOB', actionId: row.id };
  }

  private detailOf(job: Job): Record<string, unknown> {
    return { failedReason: shortReason(job.failedReason), attemptsMade: job.attemptsMade, failedAt: iso(job.finishedOn) };
  }

  private async failedJob(name: string, jobId: string): Promise<Job> {
    const q = this.queues.queue(name);
    const job = await q.getJob(jobId);
    if (!job) throw new NotFoundException(`job이 없습니다: ${name} ${jobId}`);
    const state = await job.getState();
    if (state !== 'failed') throw new BusinessError(409, 'JOB_NOT_FAILED', `실패 상태가 아닌 job입니다(지금 ${state}): ${name} ${jobId}`);
    return job;
  }

  private async notFailedAfterRace(name: string, jobId: string, error: unknown): Promise<Error> {
    const job = await this.queues.queue(name).getJob(jobId);
    if (!job) return new NotFoundException(`job이 없습니다: ${name} ${jobId}`);
    const state = await job.getState();
    if (state !== 'failed') return new BusinessError(409, 'JOB_NOT_FAILED', `실패 상태가 아닌 job입니다(지금 ${state}): ${name} ${jobId}`);
    return error instanceof Error ? error : new Error(String(error));
  }
}
