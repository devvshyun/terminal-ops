import { Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { RolloutService } from '../firmware/rollout.service.js';
import type { ProjectJobData } from '../outbox/outbox.service.js';
import { QUEUE } from '../queue/queue-names.js';
import { WORKER_OBSERVABILITY } from '../queue/worker-options.js';
import { ActiveSetService } from './active-set.service.js';
import { ConnectivityService } from './connectivity.service.js';

/**
 * device 큐. concurrency 1: 한 워커 프로세스 안에서는 active 갱신이 한 번에 하나씩 돈다(읽고 쓰는 사이에 다른 갱신이 끼지 않게).
 * 워커 프로세스가 여럿이면 겹칠 수 있고, 그 틈은 주기 재구성이 메운다(decisions/0028).
 */
@Processor(QUEUE.DEVICE, { ...WORKER_OBSERVABILITY, concurrency: 1 })
export class DeviceProcessor extends WorkerHost {
  constructor(
    private readonly activeSet: ActiveSetService,
    private readonly connectivity: ConnectivityService,
    private readonly rollouts: RolloutService,
  ) {
    super();
  }

  async process(job: Job) {
    switch (job.name) {
      case 'project':
        // payload가 깨져 serialNo가 없으면 apply가 UnrecoverableError를 던진다(재시도 없음, troubleshooting/0018)
        return this.activeSet.apply([(job.data as Partial<ProjectJobData>).serialNo]);
      case 'rebuild-active':
        return this.activeSet.rebuild();
      case 'detect-offline':
        return this.connectivity.detect();
      case 'snapshot':
        return this.connectivity.snapshot();
      case 'rollout-control':
        return this.rollouts.controlAll();
      default:
        throw new UnrecoverableError(`모르는 device job: ${job.name}`);
    }
  }
}
