import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { AnomalyService } from '../anomaly/anomaly.service.js';
import { BusinessError } from '../common/domain-errors.js';
import { QUEUE } from '../queue/queue-names.js';
import { toVanRunView, VanReconciliationService, type VanRunJobData } from '../van/van-reconciliation.service.js';
import { VanRunStatus } from '../van/van.entities.js';
import { parseKstWeekStart } from './kst-week.js';
import { isPermanentWeeklyReportError, WEEKLY_REPORT_SEND_JOB, WeeklyReportService, type WeeklyReportSendJobData } from './weekly-report.service.js';

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
        // 실패(톡톡 오류 등)는 던진다 — BullMQ가 다시 하고(WEEKLY_REPORT_JOB_OPTS), 행에 lastError가 남아 같은 파일로 이어서 보낸다.
        // 지난주를 보낸 뒤 직전 4주 중 못 보낸 주도 이어 보낸다(Task 8 리뷰, decisions/0035)
        // 영구 오류(한도 초과 422·톡톡 413 등)는 다시 해도 같다 — UnrecoverableError로 감싸 재시도 없이 실패(리뷰 반영)
        const { report, alreadySent, carriedOver } = await this.reports.sendScheduled().catch((error: unknown) => {
          if (!isPermanentWeeklyReportError(error)) throw error;
          const reason = error instanceof BusinessError ? `${error.code}: ${error.message}` : `${(error as Error).name}: ${(error as Error).message}`;
          throw new UnrecoverableError(`weekly-report 영구 오류(다시 하지 않음) — ${reason}`);
        });
        if (alreadySent) this.logger.warn(`weekly-report 건너뜀: ${report.weekStart} 주는 이미 보냄`);
        else this.logger.log(`weekly-report 끝: ${report.weekStart} 주 ${report.status}, ${report.fileSize}바이트`);
        if (carriedOver.length > 0) this.logger.log(`weekly-report 이어 보냄: ${carriedOver.map((c) => `${c.weekStart} ${c.status}`).join(', ')}`);
        return { weekStart: report.weekStart, status: report.status, alreadySent, carriedOver };
      }
      case WEEKLY_REPORT_SEND_JOB: {
        // 수동 보내기(POST /reports/weekly가 넣은 job, decisions/0038). 재시도 없음 — 실패는 행의 lastError로 남고 운영자가 다시 누른다
        const weekStart = (job.data as Partial<WeeklyReportSendJobData>).weekStart;
        const week = typeof weekStart === 'string' ? parseKstWeekStart(weekStart) : null;
        if (!week) throw new UnrecoverableError(`${WEEKLY_REPORT_SEND_JOB}: weekStart가 KST 월요일이 아닙니다: ${JSON.stringify(job.data)}`);
        try {
          const { report, alreadySent } = await this.reports.send(week);
          this.logger.log(`${WEEKLY_REPORT_SEND_JOB} 끝: ${report.weekStart} 주 ${report.status}${alreadySent ? '(이미 보냄)' : ''}`);
          return { weekStart: report.weekStart, status: report.status, alreadySent };
        } catch (error) {
          // 같은 주를 주기 job이 보내는 중 — 그쪽이 끝낸다
          if (error instanceof BusinessError && error.code === 'WEEKLY_REPORT_IN_PROGRESS') {
            this.logger.warn(`${WEEKLY_REPORT_SEND_JOB} 건너뜀: ${week.weekStart} 주를 다른 보내기가 처리 중`);
            return { weekStart: week.weekStart, skipped: true };
          }
          this.logger.warn(`${WEEKLY_REPORT_SEND_JOB} 실패: ${week.weekStart} 주 — ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
          throw isPermanentWeeklyReportError(error) ? new UnrecoverableError(`${WEEKLY_REPORT_SEND_JOB} 영구 오류 — ${String(error)}`) : error;
        }
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
