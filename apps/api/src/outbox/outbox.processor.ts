import { Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { QUEUE } from '../queue/queue-names.js';
import { OutboxService, type NotifyJobData } from './outbox.service.js';

/** outbox 큐: relay·requeue(주기 실행)와 notify(행마다) 세 종류의 job을 처리한다. */
@Processor(QUEUE.OUTBOX, { concurrency: 5 })
export class OutboxProcessor extends WorkerHost {
  constructor(private readonly outbox: OutboxService) {
    super();
  }

  async process(job: Job<NotifyJobData | Record<string, never>>) {
    if (job.name === 'relay') return this.outbox.relay();
    if (job.name === 'requeue') return this.outbox.requeueStale();
    if (job.name === 'notify') {
      // attemptsMade는 이번 시도 전까지 실패한 횟수다. 이번이 마지막 시도면 실패 시 FAILED로 남긴다.
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      return this.outbox.notify((job.data as NotifyJobData).outboxId, { lastAttempt });
    }
    throw new UnrecoverableError(`모르는 outbox job: ${job.name}`);
  }
}
