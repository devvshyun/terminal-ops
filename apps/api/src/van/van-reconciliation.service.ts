import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { EntityManager, UniqueConstraintViolationException, type QueryResult } from '@mikro-orm/mysql';
import { BusinessError } from '../common/domain-errors.js';
import { withPartnerRetry } from '../common/partner-retry.js';
import { env } from '../config/env.js';
import { QUEUE } from '../queue/queue-names.js';
import { BridgevanClient } from './bridgevan.client.js';
import { VanReconciliationRun, VanRegistrationSnapshot, VanRunStatus, VanRunTrigger, type VanPhaseMs } from './van.entities.js';

/** 주기 실행의 작업자 이름(decisions/0001) */
export const VAN_SYSTEM_ACTOR = 'system:van-reconcile';

/** 페이지 하나·시리얼 하나를 다시 부르는 최대 횟수(첫 시도 포함) */
export const VAN_CALL_ATTEMPTS = 5;

/** 스냅샷 정리 DELETE 한 번의 행 수(한 문장이 오래 잠그지 않게) */
const SNAPSHOT_DELETE_BATCH = 5000;

/** 실행 job 옵션: 실패해도 BullMQ가 다시 돌리지 않는다(실행 행에 FAILED와 이유를 남기고, 다음 실행이 처음부터 한다) */
const RUN_JOB_OPTIONS = { attempts: 1, removeOnComplete: true, removeOnFail: 100 };

export interface VanRunJobData {
  runId: number;
}

const elapsed = (start: number) => Math.round(performance.now() - start);

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
      const t = performance.now();
      const collected = await this.collect(runId);
      phaseMs.collect = elapsed(t);
      const updated = await this.em.fork().nativeUpdate(
        VanReconciliationRun,
        { id: runId, status: VanRunStatus.RUNNING },
        { status: VanRunStatus.COMPLETED, finishedAt: new Date(), heartbeatAt: new Date(), ...collected, phaseMs },
      );
      if (updated === 0) this.logger.warn(`VAN 대조 ${runId}: 끝내는 중에 RUNNING이 아니게 됨(멈춘 실행으로 정리됨) — COMPLETED로 바꾸지 않음`);
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
