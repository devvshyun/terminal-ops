import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { EntityManager, UniqueConstraintViolationException } from '@mikro-orm/mysql';
import { BusinessError } from '../common/domain-errors.js';
import { PartnerPermanentError } from '../common/partner-errors.js';
import { MAX_RETRY_AFTER_MS } from '../common/partner-http.js';
import { withPartnerRetry } from '../common/partner-retry.js';
import { DAY_MS } from '../config/env-number.js';
import { env } from '../config/env.js';
import { ToktokClient, ToktokUnknownFileError } from '../outbox/toktok.client.js';
import { QUEUE } from '../queue/queue-names.js';
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

/**
 * 다시 해도 같은 결과인 오류: 파일 한도 초과(422 WEEKLY_REPORT_TOO_LARGE)와 톡톡 영구 오류(413 등 4xx·형식 오류, PartnerPermanentError).
 * 주기 job은 이것을 BullMQ 재시도(5번)로 넘기지 않는다(리뷰 반영, decisions/0035).
 */
export function isPermanentWeeklyReportError(error: unknown): boolean {
  return error instanceof PartnerPermanentError || (error instanceof BusinessError && error.code === 'WEEKLY_REPORT_TOO_LARGE');
}

/** 수동 보내기 job(report 큐). 화면·HTTP 요청은 job만 넣고 202로 끝난다(Day 5 최종 리뷰 Minor 6, decisions/0038) */
export const WEEKLY_REPORT_SEND_JOB = 'weekly-report-send';

/** 같은 주의 수동 보내기 job은 하나 — 대기·처리 중에 다시 눌러도 BullMQ가 같은 jobId를 더 넣지 않는다 */
export const weeklyReportSendJobId = (weekStart: string) => `weekly-report-send-${weekStart}`;

/**
 * 수동 보내기 job 옵션: BullMQ 재시도 없음(실패는 행의 lastError로 남고 운영자가 다시 누른다).
 * 끝나면(성공·실패) job을 지운다 — 남아 있으면 같은 jobId를 다시 넣을 수 없다.
 */
const SEND_JOB_OPTS = { attempts: 1, removeOnComplete: true, removeOnFail: true };

/** job이 아직 끝나지 않은 상태 */
const PENDING_JOB_STATES = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);

export interface SendRequestResult extends SendResult {
  /** report 큐에 보내기 job이 있다(이번에 넣었거나 이미 있었다) */
  queued: boolean;
}

export interface WeeklyReportSendJobData {
  weekStart: string;
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
    @InjectQueue(QUEUE.REPORT) private readonly queue: Queue,
  ) {}

  /**
   * 수동 보내기 요청(POST /reports/weekly): 끝나지 않은 주는 422, 이미 보낸 주는 job 없이 alreadySent.
   * 아니면 그 주의 행을 만들고 report 큐에 job을 넣는다(같은 주는 jobId로 하나). 실제 보내기는 report 큐 처리기가 send()로 한다.
   * HTTP 요청이 톡톡 재시도·Retry-After(최악 약 10.6분)를 기다리지 않게 하려고 나눴다(Day 5 최종 리뷰 Minor 6, decisions/0038).
   */
  async request(week: KstWeek, now = new Date()): Promise<SendRequestResult> {
    this.assertEnded(week, now);
    const row = await this.ensureRow(week.weekStart);
    if (row.status === WeeklyReportStatus.SENT) return { report: row, alreadySent: true, queued: false };
    await this.queue.add(WEEKLY_REPORT_SEND_JOB, { weekStart: week.weekStart } satisfies WeeklyReportSendJobData, {
      ...SEND_JOB_OPTS,
      jobId: weeklyReportSendJobId(week.weekStart),
    });
    return { report: row, alreadySent: false, queued: true };
  }

  /** 주 목록(최근 주부터). before가 있으면 그 주보다 앞 주만(week_start unique 인덱스 범위, decisions/0039) */
  async list(q: { before?: string; limit: number }): Promise<{ items: WeeklyReport[]; nextBefore: string | null }> {
    const rows = await this.em
      .fork()
      .find(WeeklyReport, q.before ? { weekStart: { $lt: q.before } } : {}, { orderBy: { weekStart: 'desc' }, limit: q.limit + 1 });
    const items = rows.slice(0, q.limit);
    return { items, nextBefore: rows.length > q.limit ? items.at(-1)!.weekStart : null };
  }

  /**
   * 그 주의 수동 보내기 job이 아직 끝나지 않았는지(대기·처리 중)와 넣은 시각. 화면이 "보내는 중"·"N분째 대기"를 보여 줄 때 쓴다.
   * 워커(RUN_WORKERS 또는 워커 프로세스)가 없으면 job이 waiting에 남는다 — queuedAt으로 오래 기다리는 것을 드러낸다(decisions/0038).
   * 이미 보낸 주는 Redis를 보지 않는다(SENT 뒤에는 job을 넣지 않는다).
   */
  async queueState(report: Pick<WeeklyReport, 'weekStart' | 'status'>): Promise<{ queued: boolean; queuedAt: string | null }> {
    if (report.status === WeeklyReportStatus.SENT) return { queued: false, queuedAt: null };
    const job = await this.queue.getJob(weeklyReportSendJobId(report.weekStart));
    if (!job || !PENDING_JOB_STATES.has(await job.getState())) return { queued: false, queuedAt: null };
    return { queued: true, queuedAt: new Date(job.timestamp).toISOString() };
  }

  /**
   * 주기 job: now 기준 지난주를 보내고, 그 앞 4주 안에서 못 보낸 주(PENDING·GENERATED)를 최근 주부터 이어 보낸다(Task 8 리뷰).
   * 한 주가 실패해도 나머지는 해 보고, 끝에 오류를 던진다(BullMQ가 job을 다시 한다 — 보낸 주는 멱등이라 건너뛴다).
   * 리뷰 반영: 다시 해도 같은 영구 오류(isPermanentWeeklyReportError)는 재시도 5번을 쓰지 않게 나눈다.
   * - 앞선 주의 영구 오류는 warn만(행에 lastError가 남아 수동으로 본다), job 오류로 올리지 않는다.
   * - 일시 오류가 하나라도 있으면 그것을 먼저 던진다(지난주 영구 오류 뒤에 가려져 재시도가 막히지 않게).
   * - 지난주 영구 오류만 남으면 그것을 던진다 — 처리기가 UnrecoverableError로 감싸 재시도 없이 실패시킨다.
   */
  async sendScheduled(now = new Date()): Promise<ScheduledSendResult> {
    const latest = previousKstWeek(now);
    const transient: unknown[] = [];
    let latestPermanent: unknown = null;
    let latestResult: SendResult | null = null;
    try {
      latestResult = await this.send(latest, now);
    } catch (error) {
      if (isPermanentWeeklyReportError(error)) latestPermanent = error;
      else transient.push(error);
    }
    const carriedOver: ScheduledSendResult['carriedOver'] = [];
    for (const weekStart of await this.unsentWeeksBefore(latest)) {
      try {
        const { report } = await this.send(parseKstWeekStart(weekStart)!, now);
        carriedOver.push({ weekStart, status: report.status });
      } catch (error) {
        if (isPermanentWeeklyReportError(error)) {
          this.logger.warn(`주간 리포트 이어 보내기 실패 ${weekStart}(영구 오류, 다시 하지 않음): ${String(error)}`);
        } else {
          this.logger.warn(`주간 리포트 이어 보내기 실패 ${weekStart}: ${String(error)}`);
          transient.push(error);
        }
      }
    }
    if (transient.length > 0) throw transient[0];
    if (latestPermanent) throw latestPermanent;
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

  /**
   * 최종 리뷰 반영(Important 1): 끝나지 않은 주(week.to > now — 이번 주·미래 주)는 거절한다. 받아 주면 반쪽 데이터 리포트가
   * 그 주 행에 SENT로 굳고, 다음 월요일 주기 job이 그 주를 alreadySent로 건너뛰어 완전한 리포트가 영영 나가지 않는다.
   * 주기 job은 늘 지난주(to ≤ now)라 걸리지 않는다. 잠금·행을 만들기 전에 막는다(decisions/0035).
   */
  async send(week: KstWeek, now = new Date()): Promise<SendResult> {
    this.assertEnded(week, now);
    const key = this.lock.keyOf('report-lock', `weekly-${week.weekStart}`);
    const token = await this.lock.acquire(key, weeklyReportLockTtlMs());
    if (!token) throw new BusinessError(409, 'WEEKLY_REPORT_IN_PROGRESS', `${week.weekStart} 주간 리포트를 다른 요청이 보내는 중입니다.`);
    try {
      return await this.sendLocked(week, now);
    } finally {
      await this.lock.release(key, token).catch((error: unknown) => this.logger.warn(`잠금 해제 실패 weekly-${week.weekStart}: ${String(error)}`));
    }
  }

  private assertEnded(week: KstWeek, now: Date): void {
    if (week.to.getTime() > now.getTime()) {
      throw new BusinessError(
        422,
        'WEEK_NOT_ENDED',
        `${week.weekStart} 주는 아직 끝나지 않았습니다(${week.to.toISOString()}에 끝남). 끝난 주만 보낼 수 있습니다.`,
      );
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
      // status != SENT: 잠금 TTL이 지나 다른 요청이 그사이 보냈으면 SENT 행에 오류를 덮어쓰지 않는다(리뷰 반영)
      await this.em.fork().nativeUpdate(WeeklyReport, { id: row.id, status: { $ne: WeeklyReportStatus.SENT } }, { lastError: message });
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

export function toWeeklyReportView(r: WeeklyReport, alreadySent = false, queued = false, queuedAt: string | null = null) {
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
    queued,
    /** 수동 보내기 job을 넣은 시각(대기·처리 중일 때만) */
    queuedAt,
  };
}
