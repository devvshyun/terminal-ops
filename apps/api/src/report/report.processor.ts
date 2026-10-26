import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { AnomalyService } from '../anomaly/anomaly.service.js';
import { BusinessError } from '../common/domain-errors.js';
import { QUEUE } from '../queue/queue-names.js';
import { toVanRunView, VanReconciliationService, type VanRunJobData } from '../van/van-reconciliation.service.js';
import { VanRunStatus } from '../van/van.entities.js';
import { WeeklyReportService } from './weekly-report.service.js';

/**
 * report 큐: 오래 걸리는 집계 job(VAN 대조, 이상 단말기 찾기, 주간 리포트). device 큐(concurrency 1, 짧은 job)와 나눠
 * 무거운 일이 active 갱신·오프라인 판정을 막지 않게 한다(experiments/0010). 이 큐도 concurrency 1 — 집계끼리는 겹치지 않는다.
 */
@Processor(QUEUE.REPORT, { concurrency: 1 })
export class ReportProcessor extends WorkerHost {
  /** 주기 job은 밤에 사람 없이 돈다. 건너뜀은 warn, 끝나면 한 줄 요약(fix: 로그만 보고 그날 돌았는지 알 수 있게) */
  private readonly logger = new Logger(ReportProcessor.name);

  constructor(
    private readonly van: VanReconciliationService,
    private readonly anomalies: AnomalyService,
    private readonly reports: WeeklyReportService,
  ) {
    super();
  }

  async process(job: Job) {
    switch (job.name) {
      case 'van-reconcile': {
        const runId = (job.data as Partial<VanRunJobData>).runId;
        if (typeof runId !== 'number') throw new UnrecoverableError(`van-reconcile: runId가 없습니다: ${JSON.stringify(job.data)}`);
        const run = toVanRunView(await this.van.execute(runId));
        // 실패(FAILED)로 끝난 실행은 warn — execute는 실패해도 던지지 않으므로(행에 이유를 남김) 로그 수준으로 거를 수 있게(리뷰 반영)
        this.logByStatus(run.status, `van-reconcile 끝: 실행 #${runId} ${run.status}, 어긋남 ${run.confirmed}`);
        return { runId, status: run.status, confirmed: run.confirmed };
      }
      case 'van-reconcile-scheduled': {
        const result = await this.van.runScheduled();
        if (result.skipped) this.logger.warn('van-reconcile-scheduled 건너뜀: 진행 중인 VAN 대조가 있음');
        else this.logByStatus(result.status, `van-reconcile-scheduled 끝: 실행 #${result.runId} ${result.status}`);
        return result;
      }
      case 'anomaly-scan':
        try {
          const { newMatches: _new, ...summary } = await this.anomalies.scan();
          this.logger.log(`anomaly-scan 끝: 새로 ${summary.detected}, 계속 ${summary.continuing}, 풀림 ${summary.resolved}`);
          return summary;
        } catch (error) {
          // 수동 찾기가 돌고 있으면 이번 주기는 건너뛴다(그 찾기가 같은 일을 한다)
          if (error instanceof BusinessError && error.code === 'ANOMALY_SCAN_RUNNING') {
            this.logger.warn('anomaly-scan 건너뜀: 다른 이상 찾기가 돌고 있음');
            return { skipped: true };
          }
          throw error;
        }
      case 'weekly-report': {
        // 실패(톡톡 오류 등)는 던진다 — 행에 lastError가 남고, 같은 주를 다시 보내면(수동 POST·다음 job) 같은 파일로 이어서 보낸다
        const { report, alreadySent } = await this.reports.sendScheduled();
        if (alreadySent) this.logger.warn(`weekly-report 건너뜀: ${report.weekStart} 주는 이미 보냄`);
        else this.logger.log(`weekly-report 끝: ${report.weekStart} 주 ${report.status}, ${report.fileSize}바이트`);
        return { weekStart: report.weekStart, status: report.status, alreadySent };
      }
      default:
        throw new UnrecoverableError(`모르는 report job: ${job.name}`);
    }
  }

  /** 끝난 상태가 FAILED면 warn, 아니면 log */
  private logByStatus(status: string | undefined, message: string): void {
    if (status === VanRunStatus.FAILED) this.logger.warn(message);
    else this.logger.log(message);
  }
}
