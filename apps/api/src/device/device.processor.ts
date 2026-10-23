import { Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import type { ProjectJobData } from '../outbox/outbox.service.js';
import { QUEUE } from '../queue/queue-names.js';
import { ActiveSetService } from './active-set.service.js';

/**
 * device 큐. concurrency 1: 한 워커 프로세스 안에서는 active 갱신이 한 번에 하나씩 돈다(읽고 쓰는 사이에 다른 갱신이 끼지 않게).
 * 워커 프로세스가 여럿이면 겹칠 수 있고, 그 틈은 주기 재구성이 메운다(decisions/0028).
 */
@Processor(QUEUE.DEVICE, { concurrency: 1 })
export class DeviceProcessor extends WorkerHost {
  constructor(private readonly activeSet: ActiveSetService) {
    super();
  }

  async process(job: Job) {
    switch (job.name) {
      case 'project':
        return this.activeSet.apply([(job.data as ProjectJobData).serialNo]);
      case 'rebuild-active':
        return this.activeSet.rebuild();
      default:
        throw new UnrecoverableError(`모르는 device job: ${job.name}`);
    }
  }
}
