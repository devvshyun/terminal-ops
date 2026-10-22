import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { QUEUE } from '../queue/queue-names.js';

/**
 * 주기 작업 등록. BullMQ job scheduler는 Redis에 한 개만 저장되므로(같은 id면 덮어씀)
 * 이 서비스가 여러 프로세스에서 떠도 주기 작업은 하나다.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    @InjectQueue(QUEUE.CARRIER_SWEEP) private readonly sweepQueue: Queue,
    @InjectQueue(QUEUE.OUTBOX) private readonly outboxQueue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.sweepQueue.upsertJobScheduler(
      'carrier-sweep',
      { every: env.sweepIntervalMs },
      { name: 'sweep', data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
    await this.outboxQueue.upsertJobScheduler(
      'outbox-relay',
      { every: env.relayIntervalMs },
      { name: 'relay', data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
    this.logger.log(`주기 작업 등록: carrier-sweep ${env.sweepIntervalMs}ms, outbox-relay ${env.relayIntervalMs}ms`);
  }
}
