import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager, UniqueConstraintViolationException } from '@mikro-orm/mysql';
import { BusinessError } from '../common/domain-errors.js';
import { MAX_RETRY_AFTER_MS } from '../common/partner-http.js';
import { withPartnerRetry } from '../common/partner-retry.js';
import { DAY_MS } from '../config/env-number.js';
import { env } from '../config/env.js';
import { ToktokClient, ToktokUnknownFileError } from '../outbox/toktok.client.js';
import { RedisLock } from '../redis/redis-lock.js';
import { kstDate, parseKstWeekStart, previousKstWeek, type KstWeek } from './kst-week.js';
import { WeeklyReport, WeeklyReportStatus } from './weekly-report.entity.js';
import { WeeklyReportQueries } from './weekly-report.queries.js';
import { buildWeeklyReportXlsx, weeklyReportFileName, XLSX_CONTENT_TYPE } from './weekly-report.xlsx.js';

/** 톡톡 파일 올리기·메시지를 다시 부르는 최대 횟수(첫 시도 포함, 500ms·1s 간격) */
const TOKTOK_ATTEMPTS = 3;

/** 톡톡 호출 단계 최대 수: 올리기 → 메시지, 메시지가 UNKNOWN_FILE이면 다시 올리기 → 메시지 */
const TOKTOK_PHASES = 4;

/** 잠금 TTL에 더하는 집계·xlsx·DB 여유. 실험 0011에서 이력 100만 행의 집계 쿼리 하나가 0.2초 안팎이라 넉넉히 */
const COLLECT_MARGIN_MS = 2 * 60_000;

/** mediumblob 최대 크기(2^24 − 1). 이보다 큰 파일은 저장할 수 없다 */
export const MEDIUMBLOB_MAX_BYTES = 16_777_215;

/** 주기 job이 지난주와 함께 이어 보내는 범위: 지난주 앞 4주 안의 못 보낸 주 */
export const WEEKLY_REPORT_CARRY_OVER_WEEKS = 4;

/**
 * 같은 주를 보내는 동안 잡는 Redis 잠금 유지 시간 = 보내기 한 번의 최악 소요(Task 8 리뷰, decisions/0035).
 * 톡톡 단계 4개 × (시도 3번 × 호출 타임아웃 + 대기 2번 × Retry-After 상한 60초) + 집계 여유 2분. 기본 타임아웃 3초면 636초(약 10.6분).
 * 잠금이 일 도중에 풀리면 다른 요청이 같은 주를 함께 보낼 수 있으므로 짧게 잡지 않는다. 대신 프로세스가 죽으면 그만큼 409가 난다
 * (주기 job의 재시도 간격 합 15분이 이보다 길다 — WEEKLY_REPORT_JOB_OPTS).
 */
export function weeklyReportLockTtlMs(timeoutMs = env.partnerTimeoutMs): number {
  return TOKTOK_PHASES * (TOKTOK_ATTEMPTS * timeoutMs + (TOKTOK_ATTEMPTS - 1) * MAX_RETRY_AFTER_MS) + COLLECT_MARGIN_MS;
}

export interface SendResult {
  report: WeeklyReport;
  /** 이미 보낸 주라서 아무것도 하지 않았다 */
  alreadySent: boolean;
}

export interface ScheduledSendResult extends SendResult {
  /** 지난주에 이어 보낸 앞선 주들(최근 주부터) */
  carriedOver: { weekStart: string; status: WeeklyReportStatus }[];
}

/** 메신저가 같은 리포트를 한 번으로 볼 수 있게 주마다 하나 */
export const weeklyReportIdempotencyKey = (weekStart: string) => `weekly-report-${weekStart}`;

/**
 * 주간 운영 리포트 보내기(F11, decisions/0035). 주(week_start)마다 한 행이 상태를 들고 간다.
 * 1. 같은 주는 Redis 잠금으로 한 번에 하나(수동 요청과 주기 job이 겹쳐도). 행이 SENT면 아무것도 하지 않는다(멱등).
 * 2. 파일이 아직 없으면 DB에서 집계해 xlsx를 만들어 그 행에 저장한다(GENERATED). 이미 있으면 같은 파일을 다시 쓴다.
 * 3. 톡톡메신저에 파일을 올리고(fileId) 그 파일을 첨부한 메시지를 보낸다(멱등키 weekly-report-<주>). 외부 호출은 트랜잭션 밖.
 * 4. SENT로 바꾼다. 3과 4 사이에 죽으면 다시 보낸다 — 최소 한 번 + 멱등키(Outbox와 같은 보장, decisions/0016).
 *    가상 메신저는 같은 멱등키도 모두 저장한다 — 메시지 응답만 잃고 다시 보내면 같은 주가 두 번 보인다(at-least-once, decisions/0035 한계).
 * 리뷰 반영: 올린 fileId는 올리자마자 저장해 다시 보낼 때 재사용한다(메신저에 고아 파일이 쌓이지 않게). 집계·xlsx 실패도 lastError·attempts에 남는다.
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

  /**
   * 주기 job: now 기준 지난주를 보내고, 그 앞 4주 안에서 못 보낸 주(PENDING·GENERATED)를 최근 주부터 이어 보낸다(Task 8 리뷰).
   * 한 주가 실패해도 나머지는 해 보고, 끝에 첫 오류를 던진다(BullMQ가 job을 다시 한다 — 보낸 주는 멱등이라 건너뛴다).
   */
  async sendScheduled(now = new Date()): Promise<ScheduledSendResult> {
    const latest = previousKstWeek(now);
    const errors: unknown[] = [];
    let latestResult: SendResult | null = null;
    try {
      latestResult = await this.send(latest, now);
    } catch (error) {
      errors.push(error);
    }
    const carriedOver: ScheduledSendResult['carriedOver'] = [];
    for (const weekStart of await this.unsentWeeksBefore(latest)) {
      try {
        const { report } = await this.send(parseKstWeekStart(weekStart)!, now);
        carriedOver.push({ weekStart, status: report.status });
      } catch (error) {
        this.logger.warn(`주간 리포트 이어 보내기 실패 ${weekStart}: ${String(error)}`);
        errors.push(error);
      }
    }
    if (errors.length > 0) throw errors[0];
    return { ...latestResult!, carriedOver };
  }

  /** latest 앞 WEEKLY_REPORT_CARRY_OVER_WEEKS주 안에서 SENT가 아닌 주(최근 주부터) */
  private async unsentWeeksBefore(latest: KstWeek): Promise<string[]> {
    const earliest = kstDate(new Date(latest.from.getTime() - WEEKLY_REPORT_CARRY_OVER_WEEKS * 7 * DAY_MS));
    const rows = await this.em
      .fork()
      .find(
        WeeklyReport,
        { weekStart: { $gte: earliest, $lt: latest.weekStart }, status: { $ne: WeeklyReportStatus.SENT } },
        { orderBy: { weekStart: 'desc' }, fields: ['weekStart'] },
      );
    return rows.map((r) => r.weekStart);
  }

  async send(week: KstWeek, now = new Date()): Promise<SendResult> {
    const key = this.lock.keyOf('report-lock', `weekly-${week.weekStart}`);
    const token = await this.lock.acquire(key, weeklyReportLockTtlMs());
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

    // 시도 수는 SQL 증분(읽은 값 + 1이 아니라) — 겹친 시도가 서로의 증분을 덮지 않게
    await this.em.fork().getConnection().execute('update weekly_report set attempts = attempts + 1 where id = ?', [row.id], 'run');

    let fileId: string;
    try {
      const file = await this.ensureFile(row, week, now);
      const upload = async () => {
        const uploaded = await withPartnerRetry(
          () => this.toktok.uploadFile({ fileName: weeklyReportFileName(week.weekStart), contentType: XLSX_CONTENT_TYPE, content: file }),
          { attempts: TOKTOK_ATTEMPTS },
        );
        // 올리자마자 저장: 메시지가 실패해 다시 보낼 때 다시 올리지 않는다(고아 파일 방지)
        await this.em.fork().nativeUpdate(WeeklyReport, { id: row.id, status: { $ne: WeeklyReportStatus.SENT } }, { toktokFileId: uploaded.fileId });
        return uploaded.fileId;
      };
      const message = (id: string) =>
        withPartnerRetry(
          () =>
            this.toktok.send({
              idempotencyKey: weeklyReportIdempotencyKey(week.weekStart),
              text: `[단말온] 주간 운영 리포트 ${week.weekStart} 주(KST) — 첨부 ${weeklyReportFileName(week.weekStart)} (${file.length}바이트)`,
              attachments: [id],
            }),
          { attempts: TOKTOK_ATTEMPTS },
        );
      fileId = row.toktokFileId ?? (await upload());
      try {
        await message(fileId);
      } catch (error) {
        // 저장해 둔 fileId를 메신저가 모르면(보관 기간이 지났거나 메신저가 지움) 한 번만 다시 올린다
        if (!(error instanceof ToktokUnknownFileError)) throw error;
        this.logger.warn(`주간 리포트 ${week.weekStart}: 톡톡이 파일 ${fileId}를 모른다 — 다시 올림`);
        fileId = await upload();
        await message(fileId);
      }
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

  /**
   * 저장된 파일, 없으면 집계해 만들고 저장한다(GENERATED). 크기가 톡톡 한도·mediumblob 한도를 넘으면 저장하지 않고 422(리뷰 반영:
   * 넘는 파일은 메신저가 413으로, DB가 오류로 거절할 일을 미리 이유를 담아 멈춘다).
   */
  private async ensureFile(row: WeeklyReport, week: KstWeek, now: Date): Promise<Buffer> {
    const saved = row.status === WeeklyReportStatus.GENERATED ? await this.file(row.id) : null;
    if (saved) return saved;
    const file = await buildWeeklyReportXlsx(await this.queries.collect(week, now));
    const limit = Math.min(env.toktokMaxFileBytes, MEDIUMBLOB_MAX_BYTES);
    if (file.length > limit) {
      throw new BusinessError(422, 'WEEKLY_REPORT_TOO_LARGE', `${week.weekStart} 주간 리포트 파일이 ${file.length}바이트로 한도 ${limit}바이트를 넘습니다.`);
    }
    await this.em
      .fork()
      .nativeUpdate(
        WeeklyReport,
        { id: row.id, status: { $ne: WeeklyReportStatus.SENT } },
        { status: WeeklyReportStatus.GENERATED, file, fileName: weeklyReportFileName(week.weekStart), fileSize: file.length, generatedAt: now },
      );
    return file;
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
