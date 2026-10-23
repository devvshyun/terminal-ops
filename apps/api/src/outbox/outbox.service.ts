import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { UnrecoverableError, type JobsOptions, type Queue } from 'bullmq';
import { EntityManager, IsolationLevel, LockMode } from '@mikro-orm/mysql';
import { PartnerPermanentError } from '../common/partner-errors.js';
import { QUEUE } from '../queue/queue-names.js';
import { OutboxEvent, OutboxStatus } from './outbox-event.entity.js';
import { ToktokClient } from './toktok.client.js';

export interface NotifyJobData {
  outboxId: number;
}

export const NOTIFY_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 200 },
  removeOnComplete: true,
  removeOnFail: true,
};

/** 메신저가 같은 알림을 한 번으로 볼 수 있게 보내는 키. outbox 행마다 하나 */
export function idempotencyKeyOf(id: number): string {
  return `outbox-${id}`;
}

function textOf(event: OutboxEvent): string {
  const p = event.payload as { serialNo?: string; fromStatus?: string | null; toStatus?: string; actor?: string; reason?: string };
  return `[단말온] ${p.serialNo}: ${p.fromStatus ?? '신규'} → ${p.toStatus} (${p.actor}) ${p.reason}`;
}

/**
 * Outbox(F5).
 * - relay: PENDING 행을 잠그고(다른 relay가 잡은 행은 건너뜀, SKIP LOCKED) notify job을 넣은 뒤 QUEUED로 바꾼다.
 *   READ COMMITTED로 돈다. 기본(REPEATABLE READ)이면 잠금 읽기가 (status, id) 인덱스의 gap까지 잠가
 *   새 PENDING 행 INSERT(= 전이·등록 트랜잭션)를 relay가 커밋할 때까지 막는다(troubleshooting/0007).
 * - notify: 톡톡메신저로 보내고 SENT로 바꾼다. 최종 실패면 FAILED.
 * 보장 수준은 "최소 한 번 + 멱등키"다(decisions/0016).
 */
@Injectable()
export class OutboxService {
  constructor(
    private readonly em: EntityManager,
    private readonly toktok: ToktokClient,
    @InjectQueue(QUEUE.OUTBOX) private readonly queue: Queue,
  ) {}

  /**
   * @param opts.enqueue 'bulk'(기본): 잡은 행을 addBulk 한 번으로 넣는다(Redis 왕복 1번). 'each': 행마다 add(Day 2 방식).
   *   'each'는 실험 0006에서 비교하려고만 남긴다(decisions/0024).
   */
  async relay(limit = 100, opts: { enqueue?: 'bulk' | 'each' } = {}): Promise<{ queued: number[] }> {
    const queued = await this.em.fork().transactional(async (tx) => {
      const rows = await tx.find(
        OutboxEvent,
        { status: OutboxStatus.PENDING },
        { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, limit, orderBy: { id: 'asc' } },
      );
      // jobId가 같으면 BullMQ가 한 번만 받는다(addBulk도 같다). 커밋 전에 죽어 이 행이 다시 relay돼도 job이 남아 있으면 중복으로 들어가지 않는다.
      // addBulk는 MULTI가 아니라 pipeline이라 일부만 넣고 throw할 수 있다 → 이 트랜잭션이 롤백돼 행은 PENDING, 다음 relay가 같은 jobId로 다시 넣는다(decisions/0024).
      const jobs = rows.map((row) => ({
        name: 'notify',
        data: { outboxId: row.id },
        opts: { ...NOTIFY_JOB_OPTIONS, jobId: idempotencyKeyOf(row.id) },
      }));
      if (opts.enqueue === 'each') {
        for (const job of jobs) await this.queue.add(job.name, job.data, job.opts);
      } else if (jobs.length > 0) {
        await this.queue.addBulk(jobs);
      }
      for (const row of rows) row.status = OutboxStatus.QUEUED;
      return rows.map((r) => r.id);
    }, { isolationLevel: IsolationLevel.READ_COMMITTED });
    return { queued };
  }

  async notify(outboxId: number, { lastAttempt }: { lastAttempt: boolean }): Promise<'SENT' | 'SKIPPED'> {
    const em = this.em.fork();
    const row = await em.findOne(OutboxEvent, outboxId);
    if (!row || row.status === OutboxStatus.SENT || row.status === OutboxStatus.FAILED) return 'SKIPPED';

    row.attempts += 1;
    try {
      await this.toktok.send({ idempotencyKey: idempotencyKeyOf(row.id), text: textOf(row) });
    } catch (error) {
      const permanent = error instanceof PartnerPermanentError;
      row.lastError = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
      if (permanent || lastAttempt) row.status = OutboxStatus.FAILED;
      await em.flush();
      throw permanent ? new UnrecoverableError(row.lastError) : error;
    }
    // 여기서 죽으면(메신저는 받았는데 SENT를 못 씀) job이 다시 실행돼 한 번 더 보낸다 → 멱등키로 메신저가 걸러야 한다.
    row.status = OutboxStatus.SENT;
    row.sentAt = new Date();
    row.lastError = null;
    await em.flush();
    return 'SENT';
  }
}
