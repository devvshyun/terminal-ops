import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { QUEUE } from '../queue/queue-names.js';
import { JOB_SCHEDULERS } from './job-schedulers.js';

/**
 * 주기 작업 등록. BullMQ job scheduler는 Redis에 한 개만 저장되므로(같은 id면 덮어씀)
 * 이 서비스가 여러 프로세스에서 떠도 주기 작업은 하나다. 지우려면 npm run scheduler:clear (decisions/0015).
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    @InjectQueue(QUEUE.CARRIER_SWEEP) private readonly sweepQueue: Queue,
    @InjectQueue(QUEUE.OUTBOX) private readonly outboxQueue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const [sweep, relay] = JOB_SCHEDULERS;
    await this.sweepQueue.upsertJobScheduler(
      sweep.id,
      { every: env.sweepIntervalMs },
      { name: sweep.jobName, data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
    await this.outboxQueue.upsertJobScheduler(
      relay.id,
      { every: env.relayIntervalMs },
      { name: relay.jobName, data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
    this.logger.log(`주기 작업 등록: ${sweep.id} ${env.sweepIntervalMs}ms, ${relay.id} ${env.relayIntervalMs}ms`);
  }
}
