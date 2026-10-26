import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { EntityManager, IsolationLevel, UniqueConstraintViolationException, type QueryResult } from '@mikro-orm/mysql';
import { BusinessError } from '../common/domain-errors.js';
import { withPartnerRetry } from '../common/partner-retry.js';
import { env } from '../config/env.js';
import { OUTBOX_TYPE, OutboxEvent } from '../outbox/outbox-event.entity.js';
import { QUEUE } from '../queue/queue-names.js';
import type { TerminalStatus } from '../terminal/terminal-status.js';
import { BridgevanClient } from './bridgevan.client.js';
import { classify, ourValueOf, vanValueOf, type OurSide, type VanSide } from './van-compare.js';
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

/** 페이지 하나·시리얼 하나를 다시 부르는 최대 횟수(첫 시도 포함) */
export const VAN_CALL_ATTEMPTS = 5;

/** 스냅샷 정리 DELETE 한 번의 행 수(한 문장이 오래 잠그지 않게) */
const SNAPSHOT_DELETE_BATCH = 5000;

/** 재검증 때 우리 쪽을 한 번에 다시 읽는 시리얼 수(이 블록마다 하트비트도 보낸다) */
const REVERIFY_BLOCK = 100;

/** 결과 INSERT 한 문장의 행 수 */
const ITEM_INSERT_CHUNK = 500;

/** 실행 job 옵션: 실패해도 BullMQ가 다시 돌리지 않는다(실행 행에 FAILED와 이유를 남기고, 다음 실행이 처음부터 한다) */
const RUN_JOB_OPTIONS = { attempts: 1, removeOnComplete: true, removeOnFail: 100 };

export interface VanRunJobData {
  runId: number;
}

/** 집합 비교가 찾은 후보 */
export interface VanCandidate {
  serialNo: string;
  kind: VanMismatchKind;
  our: OurSide | null;
  van: VanSide | null;
}

type ItemRow = Pick<VanReconciliationItem, 'serialNo' | 'kind' | 'ourValue' | 'vanValue' | 'verified'>;

interface CompareRow {
  serial_no: string;
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
 * 브릿지VAN 등록 대조(F9, decisions/0033).
 * 1. start: 실행 행(RUNNING)을 만든다. 진행 중인 실행이 있으면 409(실행 행의 부분 unique). 하트비트가 끊긴 RUNNING은 먼저 FAILED로.
 * 2. collect: 커서로 모든 페이지를 받아 페이지마다 스테이징(van_registration_snapshot)에 한 문장으로 넣는다.
 *    429·5xx는 그 페이지만 다시 부른다(Retry-After, withPartnerRetry). 외부 호출은 트랜잭션 밖이다.
 * 3. compare: 스테이징 ⟷ terminal·merchant를 SQL 두 문장으로 비교해 어긋남 후보를 거른다(한 스냅숏, 읽기 전용 트랜잭션).
 * 4. reverify: 후보마다 VAN 단건(시리얼)과 우리 쪽을 지금 값으로 다시 읽어, 여전히 어긋난 것만 확정한다(스캔 도중 변경의 거짓 양성 제거).
 * 5. finish: 한 트랜잭션에서 실행 행 완료 + 결과 행 INSERT + Outbox 요약 알림 1행. 그 뒤 이전 실행의 스테이징을 지운다.
 * 수집 페이지·재검증 블록마다 하트비트(조건 status=RUNNING)를 보내고, 0행이면(멈춘 실행으로 정리됨) 그 자리에서 멈춘다.
 * 실행은 report 큐 job 하나가 처음부터 끝까지 한다(device 큐에 무거운 일을 넣지 않는다, experiments/0010).
 */
@Injectable()
export class VanReconciliationService {
  private readonly logger = new Logger(VanReconciliationService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly van: BridgevanClient,
    @InjectQueue(QUEUE.REPORT) private readonly queue: Queue,
  ) {}

  /** 실행 행을 만든다. 진행 중인 실행이 있으면 409 VAN_RECONCILIATION_RUNNING */
  async start(trigger: VanRunTrigger, actor: string, now = new Date()): Promise<VanReconciliationRun> {
    await this.failStale(now);
    const em = this.em.fork();
    const run = em.create(VanReconciliationRun, { trigger, requestedBy: actor, startedAt: now, heartbeatAt: now });
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
  async request(actor: string): Promise<VanReconciliationRun> {
    const run = await this.start(VanRunTrigger.MANUAL, actor);
    try {
      await this.queue.add('van-reconcile', { runId: run.id } satisfies VanRunJobData, { ...RUN_JOB_OPTIONS, jobId: `van-run-${run.id}` });
    } catch (error) {
      await this.fail(run.id, error);
      throw error;
    }
    return run;
  }

  /** 주기 실행(job scheduler). 진행 중인 실행이 있으면 건너뛴다 */
  async runScheduled(): Promise<{ runId: number | null; skipped?: boolean }> {
    let run: VanReconciliationRun;
    try {
      run = await this.start(VanRunTrigger.SCHEDULED, VAN_SYSTEM_ACTOR);
    } catch (error) {
      if (error instanceof BusinessError && error.code === 'VAN_RECONCILIATION_RUNNING') return { runId: null, skipped: true };
      throw error;
    }
    await this.execute(run.id);
    return { runId: run.id };
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
    const phaseMs: VanPhaseMs = {};
    try {
      let t = performance.now();
      const collected = await this.collect(runId);
      phaseMs.collect = elapsed(t);
      t = performance.now();
      const candidates = await this.compare(runId);
      phaseMs.compare = elapsed(t);
      t = performance.now();
      const checked = await this.reverify(runId, candidates);
      phaseMs.reverify = elapsed(t);
      await this.finish(runId, { ...collected, retries: collected.retries + checked.retries }, candidates.length, checked.items, phaseMs);
      await this.cleanupSnapshots(runId);
    } catch (error) {
      if (error instanceof VanRunNotRunningError) {
        this.logger.warn(error.message);
      } else {
        this.logger.error(`VAN 대조 ${runId} 실패: ${error instanceof Error ? error.message : String(error)}`);
        await this.fail(runId, error);
      }
    }
    return this.get(runId);
  }

  /**
   * 커서로 모든 페이지를 받아 스테이징에 넣는다. 페이지마다 INSERT 한 문장(자동 커밋) — 수집 전체를 한 트랜잭션으로 묶지 않는다
   * (외부 호출을 기다리는 동안 잠금을 쥐지 않게). 같은 시리얼이 두 번 오면 나중 값으로 덮는다.
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
      });
      await this.heartbeat(runId);
      if (page.items.length > 0) {
        await em
          .createQueryBuilder(VanRegistrationSnapshot)
          .insert(
            page.items.map((r) => ({ runId, serialNo: r.serialNo, tid: r.tid, merchantCode: r.merchantCode, status: r.status, vanUpdatedAt: r.updatedAt })),
          )
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

  /**
   * 스테이징 ⟷ terminal·merchant 집합 비교. 두 문장을 한 REPEATABLE READ 읽기 전용 트랜잭션에서 돌려 같은 시점을 본다(F10 대조와 같은 방식).
   * ① 우리 쪽 운영 중 단말기 기준(LEFT JOIN 스테이징): VAN 없음·해지·정지·가맹점 다름
   * ② VAN 쪽 ACTIVE 등록 기준(LEFT JOIN terminal): 우리가 운영 중이 아니거나 단말기가 없음
   * SQL은 어긋난 행만 거르고, 종류는 classify(재검증과 같은 함수)로 정한다. 시리얼 오름차순.
   */
  async compare(runId: number): Promise<VanCandidate[]> {
    const [inService, vanActive] = await this.em.fork().transactional(
      async (tx) => [
        await tx.execute<CompareRow[]>(
          `select t.serial_no, t.status, m.code as our_merchant, s.status as van_status, s.merchant_code as van_merchant
             from terminal t
             left join merchant m on m.id = t.merchant_id
             left join van_registration_snapshot s on s.run_id = ? and s.serial_no = t.serial_no
            where t.status = 'IN_SERVICE'
              and (s.serial_no is null or s.status <> 'ACTIVE' or m.code is null or m.code <> s.merchant_code)`,
          [runId],
        ),
        await tx.execute<CompareRow[]>(
          `select s.serial_no, t.status, m.code as our_merchant, s.status as van_status, s.merchant_code as van_merchant
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
      if (kind) out.push({ serialNo: row.serial_no, kind, our, van });
    }
    return out.sort((a, b) => (a.serialNo < b.serialNo ? -1 : a.serialNo > b.serialNo ? 1 : 0));
  }

  /**
   * 후보마다 지금 값으로 다시 본다: VAN은 시리얼 단건 조회(동시 env.vanReverifyConcurrency개), 우리 쪽은 블록마다 한 문장.
   * 여전히 어긋나면 verified=true(지금의 종류·값), 풀렸으면 verified=false(비교 때의 종류·값).
   * 블록마다 먼저 하트비트를 보낸다 — 후보가 많아 재검증이 길어도 멈춘 실행으로 보이지 않게, 그사이 정리됐으면 VAN을 더 부르지 않게.
   * @throws VanRunNotRunningError
   */
  async reverify(runId: number, candidates: VanCandidate[]): Promise<{ items: ItemRow[]; retries: number }> {
    const items: ItemRow[] = [];
    let retries = 0;
    for (let i = 0; i < candidates.length; i += REVERIFY_BLOCK) {
      await this.heartbeat(runId);
      const block = candidates.slice(i, i + REVERIFY_BLOCK);
      const vans = new Map<string, VanSide | null>();
      for (let j = 0; j < block.length; j += env.vanReverifyConcurrency) {
        const group = block.slice(j, j + env.vanReverifyConcurrency);
        const found = await Promise.all(
          group.map((c) => withPartnerRetry(() => this.van.findBySerial(c.serialNo), { attempts: VAN_CALL_ATTEMPTS, onRetry: () => retries++ })),
        );
        group.forEach((c, k) => vans.set(c.serialNo, found[k] ? { status: found[k].status, merchantCode: found[k].merchantCode } : null));
      }
      const ours = await this.ourSides(block.map((c) => c.serialNo));
      for (const c of block) {
        const our = ours.get(c.serialNo) ?? null;
        const van = vans.get(c.serialNo) ?? null;
        const kind = classify(our, van);
        items.push(
          kind
            ? { serialNo: c.serialNo, kind, ourValue: ourValueOf(our), vanValue: vanValueOf(van), verified: true }
            : { serialNo: c.serialNo, kind: c.kind, ourValue: ourValueOf(c.our), vanValue: vanValueOf(c.van), verified: false },
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
  ): Promise<void> {
    const confirmed = items.filter((it) => it.verified);
    const counts = Object.fromEntries(Object.values(VanMismatchKind).map((k) => [k, confirmed.filter((it) => it.kind === k).length]));
    const summary = { ...collected, candidates, confirmed: confirmed.length, resolved: items.length - confirmed.length, counts, phaseMs };
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
        payload: { runId, fetched: collected.fetched, candidates, confirmed: summary.confirmed, resolved: summary.resolved, counts },
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
      items: page.map((it) => ({ id: it.id, serialNo: it.serialNo, kind: it.kind, ourValue: it.ourValue, vanValue: it.vanValue, verified: it.verified })),
      nextAfterId: rows.length > q.limit ? page.at(-1)!.id : null,
    };
  }

  /** 시리얼들의 지금 상태·가맹점(재검증용, 한 문장) */
  private async ourSides(serials: string[]): Promise<Map<string, OurSide>> {
    const rows = await this.em.fork().execute<{ serial_no: string; status: TerminalStatus; merchant_code: string | null }[]>(
      `select t.serial_no, t.status, m.code as merchant_code
         from terminal t left join merchant m on m.id = t.merchant_id
        where t.serial_no in (${serials.map(() => '?').join(', ')})`,
      serials,
    );
    return new Map(rows.map((r) => [r.serial_no, { status: r.status, merchantCode: r.merchant_code }]));
  }

  /**
   * 하트비트: RUNNING일 때만 heartbeat_at을 지금으로. 0행이면 이 실행은 더 이상 RUNNING이 아니다 → 던져서 일을 그만둔다.
   * @throws VanRunNotRunningError
   */
  async heartbeat(runId: number): Promise<void> {
    const updated = await this.em.fork().nativeUpdate(VanReconciliationRun, { id: runId, status: VanRunStatus.RUNNING }, { heartbeatAt: new Date() });
    if (updated === 0) throw new VanRunNotRunningError(runId);
  }

  /** 실행 행을 FAILED로(아직 RUNNING일 때만) */
  private async fail(runId: number, error: unknown): Promise<void> {
    const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
    await this.em
      .fork()
      .nativeUpdate(VanReconciliationRun, { id: runId, status: VanRunStatus.RUNNING }, { status: VanRunStatus.FAILED, finishedAt: new Date(), error: message });
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
    startedAt: run.startedAt.toISOString(),
    heartbeatAt: run.heartbeatAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    pages: run.pages,
    fetched: run.fetched,
    retries: run.retries,
    candidates: run.candidates,
    confirmed: run.confirmed,
    resolved: run.resolved,
    counts: run.counts ?? {},
    phaseMs: run.phaseMs ?? {},
    error: run.error,
  };
}
