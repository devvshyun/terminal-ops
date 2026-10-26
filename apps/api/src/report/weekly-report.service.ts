import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager, UniqueConstraintViolationException } from '@mikro-orm/mysql';
import { BusinessError } from '../common/domain-errors.js';
import { withPartnerRetry } from '../common/partner-retry.js';
import { ToktokClient } from '../outbox/toktok.client.js';
import { RedisLock } from '../redis/redis-lock.js';
import { previousKstWeek, type KstWeek } from './kst-week.js';
import { WeeklyReport, WeeklyReportStatus } from './weekly-report.entity.js';
import { WeeklyReportQueries } from './weekly-report.queries.js';
import { buildWeeklyReportXlsx, weeklyReportFileName, XLSX_CONTENT_TYPE } from './weekly-report.xlsx.js';

/** 같은 주를 보내는 동안 잡는 Redis 잠금 유지 시간 */
const SEND_LOCK_TTL_MS = 2 * 60_000;

/** 톡톡 파일 올리기·메시지를 다시 부르는 최대 횟수(첫 시도 포함, 500ms·1s 간격) */
const TOKTOK_ATTEMPTS = 3;

export interface SendResult {
  report: WeeklyReport;
  /** 이미 보낸 주라서 아무것도 하지 않았다 */
  alreadySent: boolean;
}

/** 메신저가 같은 리포트를 한 번으로 볼 수 있게 주마다 하나 */
export const weeklyReportIdempotencyKey = (weekStart: string) => `weekly-report-${weekStart}`;

/**
 * 주간 운영 리포트 보내기(F11, decisions/0035). 주(week_start)마다 한 행이 상태를 들고 간다.
 * 1. 같은 주는 Redis 잠금으로 한 번에 하나(수동 요청과 주기 job이 겹쳐도). 행이 SENT면 아무것도 하지 않는다(멱등).
 * 2. 파일이 아직 없으면 DB에서 집계해 xlsx를 만들어 그 행에 저장한다(GENERATED). 이미 있으면 같은 파일을 다시 쓴다.
 * 3. 톡톡메신저에 파일을 올리고(fileId) 그 파일을 첨부한 메시지를 보낸다(멱등키 weekly-report-<주>). 외부 호출은 트랜잭션 밖.
 * 4. SENT로 바꾼다. 3과 4 사이에 죽으면 다시 보낸다 — 최소 한 번 + 멱등키(Outbox와 같은 보장, decisions/0016).
 */
@Injectable()
export class WeeklyReportService {
  private readonly logger = new Logger(WeeklyReportService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly queries: WeeklyReportQueries,
    private readonly toktok: ToktokClient,
    private readonly lock: RedisLock,
  ) {}

  /** 주기 job: now 기준 지난주 */
  async sendScheduled(now = new Date()): Promise<SendResult> {
    return this.send(previousKstWeek(now), now);
  }

  async send(week: KstWeek, now = new Date()): Promise<SendResult> {
    const key = this.lock.keyOf('report-lock', `weekly-${week.weekStart}`);
    const token = await this.lock.acquire(key, SEND_LOCK_TTL_MS);
    if (!token) throw new BusinessError(409, 'WEEKLY_REPORT_IN_PROGRESS', `${week.weekStart} 주간 리포트를 다른 요청이 보내는 중입니다.`);
    try {
      return await this.sendLocked(week, now);
    } finally {
      await this.lock.release(key, token).catch((error: unknown) => this.logger.warn(`잠금 해제 실패 weekly-${week.weekStart}: ${String(error)}`));
    }
  }

  private async sendLocked(week: KstWeek, now: Date): Promise<SendResult> {
    const row = await this.ensureRow(week.weekStart);
    if (row.status === WeeklyReportStatus.SENT) return { report: row, alreadySent: true };

    let file = row.status === WeeklyReportStatus.GENERATED ? await this.file(row.id) : null;
    if (!file) {
      file = await buildWeeklyReportXlsx(await this.queries.collect(week, now));
      await this.em
        .fork()
        .nativeUpdate(
          WeeklyReport,
          { id: row.id },
          { status: WeeklyReportStatus.GENERATED, file, fileName: weeklyReportFileName(week.weekStart), fileSize: file.length, generatedAt: now },
        );
    }
    await this.em.fork().nativeUpdate(WeeklyReport, { id: row.id }, { attempts: row.attempts + 1 });

    let fileId: string;
    try {
      const retry = { attempts: TOKTOK_ATTEMPTS };
      ({ fileId } = await withPartnerRetry(
        () => this.toktok.uploadFile({ fileName: weeklyReportFileName(week.weekStart), contentType: XLSX_CONTENT_TYPE, content: file }),
        retry,
      ));
      await withPartnerRetry(
        () =>
          this.toktok.send({
            idempotencyKey: weeklyReportIdempotencyKey(week.weekStart),
            text: `[단말온] 주간 운영 리포트 ${week.weekStart} 주(KST) — 첨부 ${weeklyReportFileName(week.weekStart)} (${file.length}바이트)`,
            attachments: [fileId],
          }),
        retry,
      );
    } catch (error) {
      const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
      await this.em.fork().nativeUpdate(WeeklyReport, { id: row.id }, { lastError: message });
      throw error;
    }
    await this.em
      .fork()
      .nativeUpdate(
        WeeklyReport,
        { id: row.id, status: { $ne: WeeklyReportStatus.SENT } },
        { status: WeeklyReportStatus.SENT, sentAt: new Date(), toktokFileId: fileId, lastError: null },
      );
    return { report: await this.get(week.weekStart), alreadySent: false };
  }

  /** 그 주의 행. 없으면 만든다(동시에 만들면 unique 위반 → 다시 읽는다) */
  private async ensureRow(weekStart: string): Promise<WeeklyReport> {
    const found = await this.em.fork().findOne(WeeklyReport, { weekStart });
    if (found) return found;
    const em = this.em.fork();
    em.create(WeeklyReport, { weekStart });
    try {
      await em.flush();
    } catch (error) {
      if (!(error instanceof UniqueConstraintViolationException)) throw error;
    }
    return this.get(weekStart);
  }

  async get(weekStart: string): Promise<WeeklyReport> {
    const row = await this.em.fork().findOne(WeeklyReport, { weekStart });
    if (!row) throw new NotFoundException(`${weekStart} 주간 리포트가 없습니다.`);
    return row;
  }

  /** 저장된 파일. 아직 없으면 null */
  async file(id: number): Promise<Buffer | null> {
    const row = await this.em.fork().findOne(WeeklyReport, id, { populate: ['file'] });
    return row?.file ?? null;
  }
}

export function toWeeklyReportView(r: WeeklyReport, alreadySent = false) {
  return {
    weekStart: r.weekStart,
    status: r.status,
    fileName: r.fileName,
    fileSize: r.fileSize,
    generatedAt: r.generatedAt?.toISOString() ?? null,
    sentAt: r.sentAt?.toISOString() ?? null,
    attempts: r.attempts,
    lastError: r.lastError,
    alreadySent,
  };
}
