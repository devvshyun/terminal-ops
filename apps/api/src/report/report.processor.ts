import { Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { QUEUE } from '../queue/queue-names.js';
import { toVanRunView, VanReconciliationService, type VanRunJobData } from '../van/van-reconciliation.service.js';

/**
 * report 큐: 오래 걸리는 집계 job(VAN 대조, 다음 Task의 이상 단말기 찾기·주간 리포트). device 큐(concurrency 1, 짧은 job)와 나눠
 * 무거운 일이 active 갱신·오프라인 판정을 막지 않게 한다(experiments/0010). 이 큐도 concurrency 1 — 집계끼리는 겹치지 않는다.
 */
@Processor(QUEUE.REPORT, { concurrency: 1 })
export class ReportProcessor extends WorkerHost {
  constructor(private readonly van: VanReconciliationService) {
    super();
  }

  async process(job: Job) {
    switch (job.name) {
      case 'van-reconcile': {
        const runId = (job.data as Partial<VanRunJobData>).runId;
        if (typeof runId !== 'number') throw new UnrecoverableError(`van-reconcile: runId가 없습니다: ${JSON.stringify(job.data)}`);
        const run = toVanRunView(await this.van.execute(runId));
        return { runId, status: run.status, confirmed: run.confirmed };
      }
      case 'van-reconcile-scheduled':
        return this.van.runScheduled();
      default:
        throw new UnrecoverableError(`모르는 report job: ${job.name}`);
    }
  }
}
