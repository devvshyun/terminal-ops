import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUE, type QueueName } from '../queue/queue-names.js';
import { JOB_SCHEDULERS } from './job-schedulers.js';

/**
 * 주기 작업 등록. BullMQ job scheduler는 Redis에 한 개만 저장되므로(같은 id면 덮어씀)
 * 이 서비스가 여러 프로세스에서 떠도 주기 작업은 하나다. 지우려면 npm run scheduler:clear (decisions/0015).
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly queues: Partial<Record<QueueName, Queue>>;

  constructor(
    @InjectQueue(QUEUE.CARRIER_SWEEP) sweepQueue: Queue,
    @InjectQueue(QUEUE.OUTBOX) outboxQueue: Queue,
    @InjectQueue(QUEUE.DEVICE) deviceQueue: Queue,
  ) {
    this.queues = { [QUEUE.CARRIER_SWEEP]: sweepQueue, [QUEUE.OUTBOX]: outboxQueue, [QUEUE.DEVICE]: deviceQueue };
  }

  async onApplicationBootstrap(): Promise<void> {
    for (const s of JOB_SCHEDULERS) {
      const queue = this.queues[s.queue];
      // 목록에 큐를 더하고 생성자 주입을 빠뜨리면 undefined 접근 TypeError 대신 무엇이 빠졌는지 알려 준다
      if (!queue) throw new Error(`주기 작업 ${s.id}: 주입되지 않은 큐: ${s.queue} (SchedulerService 생성자에 @InjectQueue를 더하세요)`);
      await queue.upsertJobScheduler(
        s.id,
        { every: s.every() },
        { name: s.jobName, data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } },
      );
    }
    this.logger.log(`주기 작업 등록: ${JOB_SCHEDULERS.map((s) => `${s.id} ${s.every()}ms`).join(', ')}`);
  }
}
