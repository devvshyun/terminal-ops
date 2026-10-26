import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { EntityManager, IsolationLevel, UniqueConstraintViolationException, type QueryResult } from '@mikro-orm/mysql';
import { fromDbDatetime } from '../common/db-datetime.js';
import { BusinessError } from '../common/domain-errors.js';
import { PartnerPermanentError } from '../common/partner-errors.js';
import { withPartnerRetry } from '../common/partner-retry.js';
import { env } from '../config/env.js';
import { OUTBOX_TYPE, OutboxEvent } from '../outbox/outbox-event.entity.js';
import { QUEUE } from '../queue/queue-names.js';
import type { TerminalStatus } from '../terminal/terminal-status.js';
import { BridgevanClient, type VanRegistrationDto } from './bridgevan.client.js';
import { betterRegistration, classify, ourValueOf, serialKey, vanValueOf, type OurSide, type VanSide } from './van-compare.js';
import { VAN_CALL_ATTEMPTS } from './van-limits.js';
import {
  VanMismatchKind,
  VanReconciliationItem,
  VanReconciliationRun,
  VanRegistrationSnapshot,
  VanRunStatus,
  VanRunTrigger,
  type VanPhaseMs,
  type VanStatus,
} from './van.entities.js';

/** 주기 실행의 작업자 이름(decisions/0001) */
export const VAN_SYSTEM_ACTOR = 'system:van-reconcile';

export { VAN_CALL_ATTEMPTS };

/** 스냅샷 정리 DELETE 한 번의 행 수(한 문장이 오래 잠그지 않게) */
const SNAPSHOT_DELETE_BATCH = 5000;

/** 재검증 때 우리 쪽을 한 번에 다시 읽는 시리얼 수(이 블록마다 하트비트도 보낸다. 블록 안에서는 시간 기준, env.vanHeartbeatIntervalMs) */
const REVERIFY_BLOCK = 100;

/** 결과 INSERT 한 문장의 행 수 */
const ITEM_INSERT_CHUNK = 500;

/** 실행 job 옵션: 실패해도 BullMQ가 다시 돌리지 않는다(실행 행에 FAILED와 이유를 남기고, 다음 실행이 처음부터 한다) */
const RUN_JOB_OPTIONS = { attempts: 1, removeOnComplete: true, removeOnFail: 100 };

/** 실행 시작 옵션 */
export interface StartOptions {
  /** 운영자가 수집 급감을 확인함: 이 실행만 수집 급감 검사를 건너뛴다(decisions/0033) */
  acknowledgeDrop?: boolean;
}

export interface VanRunJobData {
  runId: number;
}

/** 집합 비교가 찾은 후보 */
export interface VanCandidate {
  /** 우리 쪽 표기(우리 DB에 없으면 VAN 표기) */
  serialNo: string;
  /** 스테이징에 있는 VAN 쪽 표기. 재검증 단건 조회는 이 표기로 한다(VAN에 없으면 null → 우리 표기로 조회) */
  vanSerialNo: string | null;
  kind: VanMismatchKind;
  our: OurSide | null;
  van: VanSide | null;
}

type ItemRow = Pick<VanReconciliationItem, 'serialNo' | 'kind' | 'ourValue' | 'vanValue' | 'verified' | 'reason'>;

interface CompareRow {
  serial_no: string;
  van_serial: string | null;
  status: TerminalStatus | null;
  our_merchant: string | null;
  van_status: VanStatus | null;
  van_merchant: string | null;
}

const elapsed = (start: number) => Math.round(performance.now() - start);

function sidesOf(row: CompareRow): { our: OurSide | null; van: VanSide | null } {
  return {
    our: row.status ? { status: row.status, merchantCode: row.our_merchant } : null,
    van: row.van_status ? { status: row.van_status, merchantCode: row.van_merchant ?? '' } : null,
  };
}

/**
 * 실행 행이 더는 RUNNING이 아니다(멈춘 실행으로 보고 다른 시작이 FAILED로 바꿈, 이미 끝남). 이 실행의 일을 그만둔다.
 * 실행 행은 이미 다른 상태라 FAILED로 덮어쓰지 않는다(decisions/0033).
 */
export class VanRunNotRunningError extends Error {
  constructor(runId: number) {
    super(`VAN 대조 ${runId}이(가) RUNNING이 아님(멈춘 실행으로 정리됐거나 이미 끝남)`);
    this.name = 'VanRunNotRunningError';
  }
}

/**
 * 안전장치에 걸렸다(후보가 너무 많음, 수집 수가 급감). VAN 장애·빈 응답·우리 쪽 대량 변경일 수 있어 단건 조회를 수천 번 보내거나
 * 거대한 결과 트랜잭션을 만들지 않고 실행을 FAILED(이유)로 끝낸다(decisions/0033).
 */
export class VanSafetyValveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VanSafetyValveError';
  }
}

/** 실행 도중의 숫자(FAILED로 끝나도 실행 행에 남긴다) */
interface RunProgress {
  pages?: number;
  fetched?: number;
  retries?: number;
  candidates?: number;
  phaseMs: VanPhaseMs;
}

/**
 * 브릿지VAN 등록 대조(F9, decisions/0033).
 * 1. start: 실행 행(RUNNING)을 만든다. 진행 중인 실행이 있으면 409(실행 행의 부분 unique). 하트비트가 끊긴 RUNNING은 먼저 FAILED로.
 * 2. collect: 커서로 모든 페이지를 받아 페이지마다 스테이징(van_registration_snapshot)에 한 문장으로 넣는다.
 *    429·5xx는 그 페이지만 다시 부른다(Retry-After, withPartnerRetry). 외부 호출은 트랜잭션 밖이다.
 * 3. compare: 스테이징 ⟷ terminal·merchant를 SQL 두 문장으로 비교해 어긋남 후보를 거른다(한 스냅숏, 읽기 전용 트랜잭션).
 * 4. reverify: 후보마다 VAN 단건(시리얼)과 우리 쪽을 지금 값으로 다시 읽어, 여전히 어긋난 것만 확정한다(스캔 도중 변경의 거짓 양성 제거).
 * 5. finish: 한 트랜잭션에서 실행 행 완료 + 결과 행 INSERT + Outbox 요약 알림 1행. 그 뒤 이전 실행의 스테이징을 지운다.
 * 3과 4 사이: 안전장치(수집 수 급감·VAN 0건, 후보 수 상한)에 걸리면 재검증 없이 FAILED(이유). 운영자가 확인한 실행(acknowledgeDrop)은 수집 급감만 건너뛴다.
 * 수집 페이지·재검증 블록마다, 그리고 마지막 하트비트 뒤 env.vanHeartbeatIntervalMs가 지났으면 재검증 동시 묶음 사이·재시도 대기 앞에서도
 * 하트비트(조건 status=RUNNING)를 보내고, 0행이면(멈춘 실행으로 정리됨) 그 자리에서 멈춘다.
 * 실행은 report 큐 job 하나가 처음부터 끝까지 한다(device 큐에 무거운 일을 넣지 않는다, experiments/0010).
 */
@Injectable()
export class VanReconciliationService {
  private readonly logger = new Logger(VanReconciliationService.name);
  /** 실행별 마지막 하트비트 시각(this.clock 기준). 시간 기준 하트비트의 "간격이 지났나" 판단용 */
  private readonly lastBeatAt = new Map<number, number>();
  /** 하트비트 간격 판단에 쓰는 시계(ms). 테스트가 가짜 시계로 바꾼다 */
  clock: () => number = () => Date.now();

  constructor(
    private readonly em: EntityManager,
    private readonly van: BridgevanClient,
    @InjectQueue(QUEUE.REPORT) private readonly queue: Queue,
  ) {}

  /**
   * 실행 행을 만든다. 진행 중인 실행이 있으면 409 VAN_RECONCILIATION_RUNNING.
   * opts.acknowledgeDrop: 운영자가 수집 급감을 확인함 — 이 실행만 수집 급감 검사를 건너뛴다(실행 행에 남는다)
   */
  async start(trigger: VanRunTrigger, actor: string, now = new Date(), opts: StartOptions = {}): Promise<VanReconciliationRun> {
    await this.failStale(now);
    const em = this.em.fork();
    const run = em.create(VanReconciliationRun, { trigger, requestedBy: actor, startedAt: now, heartbeatAt: now, acknowledgeDrop: opts.acknowledgeDrop === true });
    try {
      await em.flush();
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new BusinessError(409, 'VAN_RECONCILIATION_RUNNING', '진행 중인 VAN 대조가 있습니다. 끝난 뒤 다시 요청하세요.');
      }
      throw error;
    }
    return run;
  }

  /** 수동 실행: 실행 행을 만들고 report 큐에 넣는다. 큐에 못 넣으면 그 실행을 FAILED로 남기고 던진다 */
  async request(actor: string, opts: StartOptions = {}): Promise<VanReconciliationRun> {
    const run = await this.start(VanRunTrigger.MANUAL, actor, new Date(), opts);
    try {
      await this.queue.add('van-reconcile', { runId: run.id } satisfies VanRunJobData, { ...RUN_JOB_OPTIONS, jobId: `van-run-${run.id}` });
    } catch (error) {
      await this.fail(run.id, error);
      throw error;
    }
    return run;
  }

  /** 주기 실행(job scheduler). 진행 중인 실행이 있으면 건너뛴다. 끝나면 실행 번호와 끝난 상태(로그용) */
  async runScheduled(): Promise<{ runId: number | null; status?: VanRunStatus; skipped?: boolean }> {
    let run: VanReconciliationRun;
    try {
      run = await this.start(VanRunTrigger.SCHEDULED, VAN_SYSTEM_ACTOR);
    } catch (error) {
      if (error instanceof BusinessError && error.code === 'VAN_RECONCILIATION_RUNNING') return { runId: null, skipped: true };
      throw error;
    }
    const done = await this.execute(run.id);
    return { runId: run.id, status: done.status };
  }

  /**
   * 실행 한 번을 끝까지 한다. 어디서 실패하든 실행 행을 FAILED(이유)로 남기고 행을 돌려준다(던지지 않는다 — job은 끝난다).
   * 같은 runId로 다시 불리면(멈춘 job을 BullMQ가 다시 돌림) 실행 행이 아직 RUNNING일 때만 스테이징을 지우고 처음부터 한다.
   * 이미 끝난(COMPLETED·FAILED) 실행이면 아무것도 하지 않고 행을 돌려준다 — 끝난 실행의 스테이징을 지우거나 결과를 다시 쓰지 않게.
   */
  async execute(runId: number): Promise<VanReconciliationRun> {
    const current = await this.get(runId);
    if (current.status !== VanRunStatus.RUNNING) {
      this.logger.warn(`VAN 대조 ${runId}은(는) 이미 ${current.status}라 다시 하지 않음`);
      return current;
    }
    const progress: RunProgress = { phaseMs: {} };
    const phaseMs = progress.phaseMs;
    try {
      let t = performance.now();
      const collected = await this.collect(runId);
      phaseMs.collect = elapsed(t);
      Object.assign(progress, collected);
      const inService = await this.countInService();
      await this.checkFetched(runId, collected.fetched, inService, current.acknowledgeDrop);
      t = performance.now();
      const candidates = await this.compare(runId);
      phaseMs.compare = elapsed(t);
      progress.candidates = candidates.length;
      this.checkCandidates(collected.fetched, inService, candidates.length);
      t = performance.now();
      const checked = await this.reverify(runId, candidates);
      phaseMs.reverify = elapsed(t);
      await this.finish(runId, { ...collected, retries: collected.retries + checked.retries }, candidates.length, checked.items, phaseMs, current.acknowledgeDrop);
    } catch (error) {
      if (error instanceof VanRunNotRunningError) {
        this.logger.warn(error.message);
      } else {
        this.logger.error(`VAN 대조 ${runId} 실패: ${error instanceof Error ? error.message : String(error)}`);
        await this.fail(runId, error, progress);
      }
      return this.get(runId);
    } finally {
      this.lastBeatAt.delete(runId);
    }
    // 정리는 실행 결과와 상관없다: 실패해도 COMPLETED는 그대로 두고 경고만(다음 완료 때 다시 지운다)
    try {
      await this.cleanupSnapshots(runId);
    } catch (error) {
      this.logger.warn(`VAN 대조 ${runId} 스테이징 정리 실패(다음 완료 때 다시): ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.get(runId);
  }

  /**
   * 안전장치 ①: 수집 급감이면 VanSafetyValveError.
   * - VAN 0건인데 우리 운영 중 단말기가 있음(첫 실행이어도 — 비교할 이전 실행이 없을 때의 빈 응답)
   * - 수집 수가 마지막 COMPLETED 실행의 env.vanFetchMinPct% 미만. 기준은 FAILED가 아니라 마지막 COMPLETED(반쪽 수집을 기준으로 삼지 않게)
   * VAN이 빈 목록·일부만 주는 장애면 "운영 중인데 VAN에 없음"이 대량으로 생긴다. env.vanFetchMinPct=0이면 둘 다 끈다.
   * 운영자가 급감을 확인한 실행(acknowledgeDrop)은 이 검사만 건너뛴다(경고 로그, 실행 행·알림에 남음). 후보 수 상한(②)은 그대로.
   */
  private async checkFetched(runId: number, fetched: number, inService: number, acknowledged: boolean): Promise<void> {
    if (env.vanFetchMinPct === 0) return;
    if (acknowledged) {
      this.logger.warn(`VAN 대조 ${runId}: 급감 확인 플래그로 수집 급감 검사를 건너뜀(수집 ${fetched}, 운영 중 ${inService})`);
      return;
    }
    if (fetched === 0 && inService > 0) {
      throw new VanSafetyValveError(
        `수집 0건인데 운영 중 단말기가 ${inService}대입니다(VAN 장애·빈 응답 의심, 재검증하지 않음). 확인했으면 acknowledgeDrop으로 다시 실행하세요.`,
      );
    }
    const [last] = await this.em
      .fork()
      .find(VanReconciliationRun, { status: VanRunStatus.COMPLETED, id: { $lt: runId } }, { fields: ['id', 'fetched'], orderBy: { id: 'desc' }, limit: 1 });
    if (!last || last.fetched === 0) return;
    if (fetched * 100 < last.fetched * env.vanFetchMinPct) {
      throw new VanSafetyValveError(
        `수집 ${fetched}건이 마지막 완료 실행 #${last.id}의 ${last.fetched}건의 ${env.vanFetchMinPct}% 미만입니다(VAN 장애·빈 응답 의심, 재검증하지 않음). 확인했으면 acknowledgeDrop으로 다시 실행하세요.`,
      );
    }
  }

  /**
   * 안전장치 ②: 후보가 max(env.vanCandidateAbsCap, max(수집 수, 우리 운영 중 수) × env.vanCandidateMaxPct%)를 넘으면 VanSafetyValveError.
   * 분모에 우리 운영 중 수도 넣는다 — VAN이 적게 줄수록(수집 수가 작을수록) 상한이 작아져 정상 규모의 어긋남까지 막지 않게.
   */
  private checkCandidates(fetched: number, inService: number, candidates: number): void {
    const base = Math.max(fetched, inService);
    const cap = Math.max(env.vanCandidateAbsCap, Math.floor((base * env.vanCandidateMaxPct) / 100));
    if (candidates > cap) {
      throw new VanSafetyValveError(
        `후보 ${candidates}건이 상한 ${cap}건(max(${env.vanCandidateAbsCap}, max(수집 ${fetched}, 운영 중 ${inService}) × ${env.vanCandidateMaxPct}%))을 넘습니다(재검증하지 않음).`,
      );
    }
  }

  /** 우리 운영 중 단말기 수((status, status_changed_at) 인덱스의 status 앞부분 범위) */
  private async countInService(): Promise<number> {
    const [row] = await this.em.fork().execute<{ n: number }[]>(`select count(*) as n from terminal where status = 'IN_SERVICE'`);
    return Number(row.n);
  }

  /**
   * 커서로 모든 페이지를 받아 스테이징에 넣는다. 페이지마다 INSERT 한 문장(자동 커밋) — 수집 전체를 한 트랜잭션으로 묶지 않는다
   * (외부 호출을 기다리는 동안 잠금을 쥐지 않게). 시리얼·가맹점 코드는 앞뒤 공백을 지워 넣는다(SQL 비교 collation이 NO PAD라).
   * 같은 시리얼(serialKey 기준 = 스테이징 PK collation과 같은 동치)이 두 번 오면 betterRegistration으로 하나를 고른다 — 페이지 안은 TS에서,
   * 페이지 사이는 이미 넣은 행을 PK로 읽어 비교한다("VAN에서 시리얼은 유일" 가정이 깨졌을 때만 의미가 있다).
   * 시작할 때와 페이지를 받을 때마다 하트비트를 갱신하고, 실행이 RUNNING이 아니면(멈춘 실행으로 정리됨) 그 페이지를 넣지 않고 멈춘다.
   * @throws VanRunNotRunningError
   */
  async collect(runId: number): Promise<{ pages: number; fetched: number; retries: number }> {
    await this.heartbeat(runId);
    await this.deleteSnapshot(runId);
    const em = this.em.fork();
    let cursor: string | null = null;
    let pages = 0;
    let fetched = 0;
    let retries = 0;
    do {
      const page = await withPartnerRetry(() => this.van.list(cursor, env.bridgevanPageSize), {
        attempts: VAN_CALL_ATTEMPTS,
        onRetry: () => retries++,
        beforeWait: () => this.heartbeatIfDue(runId),
      });
      await this.heartbeat(runId);
      const rows = await this.pickPageRows(em, runId, page.items);
      if (rows.length > 0) {
        await em
          .createQueryBuilder(VanRegistrationSnapshot)
          .insert(rows.map((r) => ({ runId, serialNo: r.serialNo, tid: r.tid, merchantCode: r.merchantCode, status: r.status, vanUpdatedAt: r.updatedAt })))
          .onConflict(['runId', 'serialNo'])
          .merge(['tid', 'merchantCode', 'status', 'vanUpdatedAt'])
          .execute();
      }
      pages++;
      fetched += page.items.length;
      cursor = page.nextCursor;
    } while (cursor);
    return { pages, fetched, retries };
  }

  /** 한 페이지에서 넣을 행: 정규화하고, 페이지 안·이미 넣은 행과 같은 시리얼이면 betterRegistration이 고른 것만 */
  private async pickPageRows(em: EntityManager, runId: number, items: VanRegistrationDto[]): Promise<VanRegistrationDto[]> {
    const best = new Map<string, VanRegistrationDto>();
    for (const raw of items) {
      const r = { ...raw, serialNo: raw.serialNo.trim(), merchantCode: raw.merchantCode.trim() };
      const key = serialKey(r.serialNo);
      const prev = best.get(key);
      best.set(key, prev ? betterRegistration(prev, r) : r);
    }
    if (best.size === 0) return [];
    const serials = [...best.values()].map((r) => r.serialNo);
    const existing = await em.execute<{ serial_no: string; status: VanStatus; van_updated_at: string }[]>(
      `select serial_no, status, van_updated_at from van_registration_snapshot where run_id = ? and serial_no in (${serials.map(() => '?').join(', ')})`,
      [runId, ...serials],
    );
    for (const e of existing) {
      const key = serialKey(e.serial_no);
      const incoming = best.get(key);
      const stored: Pick<VanRegistrationDto, 'status' | 'updatedAt'> = { status: e.status, updatedAt: fromDbDatetime(e.van_updated_at) };
      if (incoming && betterRegistration<Pick<VanRegistrationDto, 'status' | 'updatedAt'>>(stored, incoming) !== incoming) best.delete(key);
    }
    return [...best.values()];
  }

  /**
   * 스테이징 ⟷ terminal·merchant 집합 비교. 두 문장을 한 REPEATABLE READ 읽기 전용 트랜잭션에서 돌려 같은 시점을 본다(F10 대조와 같은 방식).
   * ① 우리 쪽 운영 중 단말기 기준(LEFT JOIN 스테이징): VAN 없음·해지·정지·가맹점 다름
   * ② VAN 쪽 ACTIVE 등록 기준(LEFT JOIN terminal): 우리가 운영 중이 아니거나 단말기가 없음
   * SQL은 어긋난 행만 거르고, 종류는 classify(재검증과 같은 함수)로 정한다. 시리얼(serialKey) 오름차순.
   * 조인은 테이블 collation(대소문자 무시)으로 한다 — TS 쪽도 serialKey로 같은 동치를 쓴다.
   */
  async compare(runId: number): Promise<VanCandidate[]> {
    const [inService, vanActive] = await this.em.fork().transactional(
      async (tx) => [
        await tx.execute<CompareRow[]>(
          `select t.serial_no, s.serial_no as van_serial, t.status, m.code as our_merchant, s.status as van_status, s.merchant_code as van_merchant
             from terminal t
             left join merchant m on m.id = t.merchant_id
             left join van_registration_snapshot s on s.run_id = ? and s.serial_no = t.serial_no
            where t.status = 'IN_SERVICE'
              and (s.serial_no is null or s.status <> 'ACTIVE' or m.code is null or m.code <> s.merchant_code)`,
          [runId],
        ),
        await tx.execute<CompareRow[]>(
          `select coalesce(t.serial_no, s.serial_no) as serial_no, s.serial_no as van_serial, t.status, m.code as our_merchant, s.status as van_status, s.merchant_code as van_merchant
             from van_registration_snapshot s
             left join terminal t on t.serial_no = s.serial_no
             left join merchant m on m.id = t.merchant_id
            where s.run_id = ? and s.status = 'ACTIVE' and (t.id is null or t.status <> 'IN_SERVICE')`,
          [runId],
        ),
      ],
      { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
    );
    const out: VanCandidate[] = [];
    for (const row of [...inService, ...vanActive]) {
      const { our, van } = sidesOf(row);
      const kind = classify(our, van);
      if (kind) out.push({ serialNo: row.serial_no, vanSerialNo: row.van_serial, kind, our, van });
    }
    return out.sort((a, b) => {
      const [x, y] = [serialKey(a.serialNo), serialKey(b.serialNo)];
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }

  /**
   * 후보마다 지금 값으로 다시 본다: VAN은 시리얼 단건 조회(동시 env.vanReverifyConcurrency개), 우리 쪽은 블록마다 한 문장.
   * 여전히 어긋나면 verified=true(지금의 종류·값), 풀렸으면 verified=false(비교 때의 종류·값).
   * 후보 하나의 VAN 조회가 영구 오류(4xx·형식, PartnerPermanentError)면 그 후보만 verified=false + reason(확인 불가)으로 남긴다 —
   * 한 건 때문에 실행 전체를 버리지 않게. 재시도를 다 쓴 429·5xx는 VAN 장애라 실행을 FAILED로(그대로 던진다).
   * 블록마다 먼저 하트비트를 보내고, 블록 안에서는 동시 묶음 사이·재시도 대기 앞에서 마지막 하트비트 뒤 env.vanHeartbeatIntervalMs가
   * 지났으면 보낸다 — 느린 VAN(제한 시간·Retry-After)에 블록 하나가 길어져도 멈춘 실행으로 보이지 않게, 그사이 정리됐으면 VAN을 더 부르지 않게.
   * @throws VanRunNotRunningError
   */
  async reverify(runId: number, candidates: VanCandidate[]): Promise<{ items: ItemRow[]; retries: number }> {
    const items: ItemRow[] = [];
    let retries = 0;
    for (let i = 0; i < candidates.length; i += REVERIFY_BLOCK) {
      await this.heartbeat(runId);
      const block = candidates.slice(i, i + REVERIFY_BLOCK);
      const vans = new Map<string, { van: VanSide | null } | { error: PartnerPermanentError }>();
      for (let j = 0; j < block.length; j += env.vanReverifyConcurrency) {
        if (j > 0) await this.heartbeatIfDue(runId);
        const group = block.slice(j, j + env.vanReverifyConcurrency);
        const found = await Promise.all(
          group.map((c) =>
            withPartnerRetry(() => this.van.findBySerial(c.vanSerialNo ?? c.serialNo), {
              attempts: VAN_CALL_ATTEMPTS,
              onRetry: () => retries++,
              beforeWait: () => this.heartbeatIfDue(runId),
            }).then(
              (r): { van: VanSide | null } => ({ van: r ? { status: r.status, merchantCode: r.merchantCode } : null }),
              (error: unknown): { error: PartnerPermanentError } => {
                if (error instanceof PartnerPermanentError) return { error };
                throw error;
              },
            ),
          ),
        );
        group.forEach((c, k) => vans.set(serialKey(c.serialNo), found[k]));
      }
      const ours = await this.ourSides(block.map((c) => c.serialNo));
      for (const c of block) {
        const key = serialKey(c.serialNo);
        const checked = vans.get(key)!;
        const asFound = { serialNo: c.serialNo, kind: c.kind, ourValue: ourValueOf(c.our), vanValue: vanValueOf(c.van), verified: false };
        if ('error' in checked) {
          items.push({ ...asFound, reason: `재검증 실패: ${checked.error.name}: ${checked.error.message}`.slice(0, 200) });
          continue;
        }
        const our = ours.get(key) ?? null;
        const kind = classify(our, checked.van);
        items.push(
          kind
            ? { serialNo: c.serialNo, kind, ourValue: ourValueOf(our), vanValue: vanValueOf(checked.van), verified: true, reason: null }
            : { ...asFound, reason: null },
        );
      }
    }
    return { items, retries };
  }

  /**
   * 실행 행 완료 + 결과 INSERT + Outbox 요약 1행을 한 트랜잭션으로(실행 행 → 결과 행 순서).
   * 실행 행 UPDATE(조건 status=RUNNING)가 0행이면 끝내는 순간 멈춘 실행으로 정리된 것 → VanRunNotRunningError로 결과도 롤백한다
   * (execute가 경고 로그를 남기고, 실행 행의 이유는 덮어쓰지 않는다).
   */
  private async finish(
    runId: number,
    collected: { pages: number; fetched: number; retries: number },
    candidates: number,
    items: ItemRow[],
    phaseMs: VanPhaseMs,
    acknowledgeDrop: boolean,
  ): Promise<void> {
    const confirmed = items.filter((it) => it.verified);
    const unverifiable = items.filter((it) => it.reason).length;
    const counts = Object.fromEntries(Object.values(VanMismatchKind).map((k) => [k, confirmed.filter((it) => it.kind === k).length]));
    const summary = { ...collected, candidates, confirmed: confirmed.length, resolved: items.length - confirmed.length - unverifiable, unverifiable, counts, phaseMs };
    await this.em.fork().transactional(async (tx) => {
      const now = new Date();
      const updated = await tx.nativeUpdate(
        VanReconciliationRun,
        { id: runId, status: VanRunStatus.RUNNING },
        { status: VanRunStatus.COMPLETED, finishedAt: now, heartbeatAt: now, ...summary },
      );
      if (updated === 0) throw new VanRunNotRunningError(runId);
      for (let i = 0; i < items.length; i += ITEM_INSERT_CHUNK) {
        await tx.insertMany(
          VanReconciliationItem,
          items.slice(i, i + ITEM_INSERT_CHUNK).map((it) => ({ ...it, run: runId })),
        );
      }
      // 묶음 원칙: 어긋남이 몇 건이든 알림은 요약 1행(experiments/0010, decisions/0029)
      tx.create(OutboxEvent, {
        type: OUTBOX_TYPE.VAN_RECONCILIATION_COMPLETED,
        payload: { runId, fetched: collected.fetched, candidates, confirmed: summary.confirmed, resolved: summary.resolved, unverifiable, counts, acknowledgeDrop },
      });
    });
  }

  /** 이번 실행보다 앞선 실행들(COMPLETED·FAILED 모두)의 스테이징을 지운다(이번 실행 것만 남긴다) */
  async cleanupSnapshots(currentRunId: number): Promise<number> {
    const old = await this.em
      .fork()
      .execute<{ run_id: number }[]>('select distinct run_id from van_registration_snapshot where run_id < ? order by run_id', [currentRunId]);
    let deleted = 0;
    for (const r of old) deleted += await this.deleteSnapshot(r.run_id);
    return deleted;
  }

  /** 한 실행의 스테이징을 PK 범위(run_id)로 조금씩 지운다(자동 커밋 DELETE를 되풀이). @returns 지운 행 수 */
  async deleteSnapshot(runId: number): Promise<number> {
    const em = this.em.fork();
    let deleted = 0;
    for (;;) {
      const res = await em.execute<QueryResult>('delete from van_registration_snapshot where run_id = ? order by serial_no limit ?', [runId, SNAPSHOT_DELETE_BATCH], 'run');
      deleted += res.affectedRows;
      if (res.affectedRows < SNAPSHOT_DELETE_BATCH) return deleted;
    }
  }

  async get(id: number): Promise<VanReconciliationRun> {
    const run = await this.em.fork().findOne(VanReconciliationRun, id);
    if (!run) throw new NotFoundException(`VAN 대조 ${id}이(가) 없습니다.`);
    return run;
  }

  /** 결과 행 한 페이지(id 순, afterId 뒤부터). 다음 페이지가 있으면 nextAfterId */
  async items(runId: number, q: { kind?: VanMismatchKind; verified?: boolean; afterId?: number; limit: number }) {
    const rows = await this.em.fork().find(
      VanReconciliationItem,
      {
        run: runId,
        id: { $gt: q.afterId ?? 0 },
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.verified === undefined ? {} : { verified: q.verified }),
      },
      { orderBy: { id: 'asc' }, limit: q.limit + 1 },
    );
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((it) => ({ id: it.id, serialNo: it.serialNo, kind: it.kind, ourValue: it.ourValue, vanValue: it.vanValue, verified: it.verified, reason: it.reason })),
      nextAfterId: rows.length > q.limit ? page.at(-1)!.id : null,
    };
  }

  /** 시리얼들의 지금 상태·가맹점(재검증용, 한 문장). 키는 serialKey(IN 비교가 collation으로 대소문자를 무시하므로 같은 동치) */
  private async ourSides(serials: string[]): Promise<Map<string, OurSide>> {
    const rows = await this.em.fork().execute<{ serial_no: string; status: TerminalStatus; merchant_code: string | null }[]>(
      `select t.serial_no, t.status, m.code as merchant_code
         from terminal t left join merchant m on m.id = t.merchant_id
        where t.serial_no in (${serials.map(() => '?').join(', ')})`,
      serials,
    );
    return new Map(rows.map((r) => [serialKey(r.serial_no), { status: r.status, merchantCode: r.merchant_code }]));
  }

  /**
   * 하트비트: RUNNING일 때만 heartbeat_at을 지금으로. 0행이면 이 실행은 더 이상 RUNNING이 아니다 → 던져서 일을 그만둔다.
   * @throws VanRunNotRunningError
   */
  async heartbeat(runId: number): Promise<void> {
    const updated = await this.em.fork().nativeUpdate(VanReconciliationRun, { id: runId, status: VanRunStatus.RUNNING }, { heartbeatAt: new Date() });
    if (updated === 0) throw new VanRunNotRunningError(runId);
    this.lastBeatAt.set(runId, this.clock());
  }

  /** 마지막 하트비트 뒤 env.vanHeartbeatIntervalMs가 지났을 때만 하트비트(호출마다 UPDATE하지 않게). @throws VanRunNotRunningError */
  private async heartbeatIfDue(runId: number): Promise<void> {
    const last = this.lastBeatAt.get(runId);
    if (last === undefined || this.clock() - last >= env.vanHeartbeatIntervalMs) await this.heartbeat(runId);
  }

  /** 실행 행을 FAILED로(아직 RUNNING일 때만). 그때까지의 숫자(페이지·수집·후보·단계 시간)가 있으면 함께 남긴다 */
  private async fail(runId: number, error: unknown, progress?: RunProgress): Promise<void> {
    const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
    await this.em
      .fork()
      .nativeUpdate(
        VanReconciliationRun,
        { id: runId, status: VanRunStatus.RUNNING },
        { status: VanRunStatus.FAILED, finishedAt: new Date(), error: message, ...(progress ?? {}) },
      );
  }

  /**
   * 하트비트가 끊긴 RUNNING 실행(프로세스가 죽어 끝나지 못함)을 FAILED로. 잠그지 않고 읽은 뒤 PK로 갱신한다(troubleshooting/0014).
   * 시작 시각이 아니라 마지막 하트비트로 본다 — 수집이 길어도 페이지를 받고 있으면 살아 있다(decisions/0033).
   * 갱신 조건에도 하트비트를 다시 넣어, 읽은 뒤 그 실행이 하트비트를 보냈으면 건드리지 않는다.
   */
  private async failStale(now: Date): Promise<void> {
    const em = this.em.fork();
    const before = new Date(now.getTime() - env.vanRunHeartbeatStaleMs);
    const stale = await em.find(VanReconciliationRun, { status: VanRunStatus.RUNNING, heartbeatAt: { $lt: before } }, { fields: ['id'] });
    if (stale.length === 0) return;
    await em.nativeUpdate(
      VanReconciliationRun,
      { id: { $in: stale.map((r) => r.id) }, status: VanRunStatus.RUNNING, heartbeatAt: { $lt: before } },
      { status: VanRunStatus.FAILED, finishedAt: now, error: `멈춘 실행: 하트비트가 ${env.vanRunHeartbeatStaleMs}ms 넘게 없음` },
    );
    this.logger.warn(`멈춘 VAN 대조 실행을 FAILED로: ${stale.map((r) => r.id).join(', ')}`);
  }
}

export function toVanRunView(run: VanReconciliationRun) {
  return {
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    requestedBy: run.requestedBy,
    acknowledgeDrop: run.acknowledgeDrop,
    startedAt: run.startedAt.toISOString(),
    heartbeatAt: run.heartbeatAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    pages: run.pages,
    fetched: run.fetched,
    retries: run.retries,
    candidates: run.candidates,
    confirmed: run.confirmed,
    resolved: run.resolved,
    unverifiable: run.unverifiable,
    counts: run.counts ?? {},
    phaseMs: run.phaseMs ?? {},
    error: run.error,
  };
}
