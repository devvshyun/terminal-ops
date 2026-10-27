import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { UnrecoverableError, type JobsOptions, type Queue } from 'bullmq';
import { EntityManager, IsolationLevel, LockMode } from '@mikro-orm/mysql';
import { formatKst } from '../common/kst.js';
import { env } from '../config/env.js';
import { PartnerPermanentError } from '../common/partner-errors.js';
import { QUEUE } from '../queue/queue-names.js';
import { ANOMALY_RULE_LABEL } from '../anomaly/anomaly-labels.js';
import type { AnomalyRule } from '../anomaly/anomaly.entity.js';
import { KIND_LABEL } from '../van/van-labels.js';
import type { VanMismatchKind } from '../van/van.entities.js';
import { OUTBOX_TYPE, OutboxEvent, OutboxStatus } from './outbox-event.entity.js';
import { ToktokClient } from './toktok.client.js';

export interface NotifyJobData {
  outboxId: number;
}

export const NOTIFY_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 200 },
  removeOnComplete: true,
  removeOnFail: true,
};

/** active 갱신(project) job 옵션. 실패하면 몇 번 다시 하고, 그래도 안 되면 주기 재구성이 맞춘다(decisions/0028). */
export const PROJECT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 200 },
  removeOnComplete: true,
  removeOnFail: true,
};

export interface ProjectJobData {
  serialNo: string;
}

/** 운영 중 단말기 목록(Redis active)을 바꾸는 이벤트인가: IN_SERVICE로 들어오거나 IN_SERVICE에서 나가는 상태 변경 */
export function changesActiveSet(row: OutboxEvent): boolean {
  if (row.type !== OUTBOX_TYPE.TERMINAL_STATUS_CHANGED) return false;
  const p = row.payload as { fromStatus?: string | null; toStatus?: string };
  return p.toStatus === 'IN_SERVICE' || p.fromStatus === 'IN_SERVICE';
}

/** 메신저가 같은 알림을 한 번으로 볼 수 있게 보내는 키. outbox 행마다 하나 */
export function idempotencyKeyOf(id: number): string {
  return `outbox-${id}`;
}

/** 묶음 알림 문구에 적는 시리얼 수(나머지는 "외 N대") */
const BULK_TEXT_SERIALS = 5;

/** 알림 문구. type마다 다르다(decisions/0016 "다시 볼 조건"). 시각은 KST로 적는다(payload는 UTC ISO 그대로, fix) */
export function textOf(event: Pick<OutboxEvent, 'type' | 'payload'>): string {
  const p = event.payload as {
    serialNo?: string;
    fromStatus?: string | null;
    toStatus?: string;
    actor?: string;
    reason?: string;
    lastSeenAt?: string;
    count?: number;
    serials?: string[];
    detectedAt?: string;
    rolloutId?: number;
    version?: string;
    stage?: number;
    percent?: number;
    runId?: number;
    fetched?: number;
    confirmed?: number;
    resolved?: number;
    unverifiable?: number;
    acknowledgeDrop?: boolean;
    counts?: Partial<Record<VanMismatchKind, number>>;
    rule?: AnomalyRule;
    days?: number;
    byRule?: Partial<Record<AnomalyRule, number>>;
  };
  if (event.type === OUTBOX_TYPE.ANOMALY_DETECTED) {
    return `[단말온] 이상 단말기 ${p.serialNo}: ${ANOMALY_RULE_LABEL[p.rule!] ?? p.rule}${p.days === undefined ? '' : ` (${p.days}일)`}`;
  }
  if (event.type === OUTBOX_TYPE.ANOMALY_DETECTED_BULK) {
    const byRule = Object.entries(ANOMALY_RULE_LABEL)
      .filter(([rule]) => (p.byRule?.[rule as AnomalyRule] ?? 0) > 0)
      .map(([rule, label]) => `${label} ${p.byRule![rule as AnomalyRule]}`)
      .join(', ');
    return `[단말온] 이상 단말기 ${p.count}대 새로 발견 (${byRule}, 판정 ${formatKst(p.detectedAt)})`;
  }
  if (event.type === OUTBOX_TYPE.VAN_RECONCILIATION_COMPLETED) {
    const byKind = Object.entries(KIND_LABEL)
      .map(([kind, label]) => `${label} ${p.counts?.[kind as VanMismatchKind] ?? 0}`)
      .join(', ');
    const unverifiable = p.unverifiable ? `, 확인 불가 ${p.unverifiable}건` : '';
    return `[단말온] VAN 등록 대조 #${p.runId}: 어긋남 ${p.confirmed}건(${byKind}), 재검증으로 풀림 ${p.resolved}건${unverifiable}, VAN 등록 ${p.fetched}건${p.acknowledgeDrop ? ' (수집 급감 확인 후 실행)' : ''}`;
  }
  if (event.type === OUTBOX_TYPE.DEVICE_OFFLINE_BULK || event.type === OUTBOX_TYPE.DEVICE_ONLINE_BULK) {
    const what = event.type === OUTBOX_TYPE.DEVICE_OFFLINE_BULK ? '오프라인' : '온라인 복귀';
    const shown = (p.serials ?? []).slice(0, BULK_TEXT_SERIALS);
    const rest = (p.count ?? 0) - shown.length;
    return `[단말온] 단말기 ${p.count}대 ${what} (${shown.join(', ')}${rest > 0 ? ` 외 ${rest}대` : ''}, 판정 ${formatKst(p.detectedAt)})`;
  }
  if (event.type === OUTBOX_TYPE.DEVICE_OFFLINE) return `[단말온] ${p.serialNo}: 오프라인 (마지막 하트비트 ${formatKst(p.lastSeenAt)})`;
  if (event.type === OUTBOX_TYPE.DEVICE_ONLINE) return `[단말온] ${p.serialNo}: 온라인 복귀 (하트비트 ${formatKst(p.lastSeenAt)})`;
  if (event.type === OUTBOX_TYPE.FIRMWARE_STAGE_ADVANCED) {
    return `[단말온] 펌웨어 배포 #${p.rolloutId} ${p.version}: ${(p.stage ?? 0) + 1}단계(${p.percent}%) 시작`;
  }
  if (event.type === OUTBOX_TYPE.FIRMWARE_ROLLOUT_COMPLETED) return `[단말온] 펌웨어 배포 #${p.rolloutId} ${p.version}: 완료`;
  if (event.type === OUTBOX_TYPE.FIRMWARE_ROLLOUT_ABORTED) return `[단말온] 펌웨어 배포 #${p.rolloutId} ${p.version}: 중단 (${p.reason})`;
  return `[단말온] ${p.serialNo}: ${p.fromStatus ?? '신규'} → ${p.toStatus} (${p.actor}) ${p.reason}`;
}

/**
 * Outbox(F5).
 * - relay: PENDING 행을 잠그고(다른 relay가 잡은 행은 건너뜀, SKIP LOCKED) project job(해당 행만)·notify job 순서로 넣은 뒤 QUEUED로 바꾼다.
 *   READ COMMITTED로 돈다. 기본(REPEATABLE READ)이면 잠금 읽기가 (status, id) 인덱스의 gap까지 잠가
 *   새 PENDING 행 INSERT(= 전이·등록 트랜잭션)를 relay가 커밋할 때까지 막는다(troubleshooting/0007).
 * - notify: 톡톡메신저로 보내고 SENT로 바꾼다. 최종 실패면 FAILED.
 * - requeue: QUEUED인데 notify job이 큐에 없는 행에 job을 다시 넣는다(주기 작업, decisions/0042).
 * 보장 수준은 "최소 한 번 + 멱등키"다(decisions/0016).
 */
@Injectable()
export class OutboxService {
  constructor(
    private readonly em: EntityManager,
    private readonly toktok: ToktokClient,
    @InjectQueue(QUEUE.OUTBOX) private readonly queue: Queue,
    @InjectQueue(QUEUE.DEVICE) private readonly deviceQueue: Queue,
  ) {}

  /**
   * @param opts.enqueue 'bulk'(기본): 잡은 행을 addBulk 한 번으로 넣는다(Redis 왕복 1번). 'each': 행마다 add(Day 2 방식).
   *   'each'는 실험 0006에서 비교하려고만 남긴다(decisions/0024).
   */
  async relay(limit = 100, opts: { enqueue?: 'bulk' | 'each' } = {}): Promise<{ queued: number[] }> {
    const queued = await this.em.fork().transactional(async (tx) => {
      const rows = await tx.find(
        OutboxEvent,
        { status: OutboxStatus.PENDING },
        { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, limit, orderBy: { id: 'asc' } },
      );
      // 넣는 순서: 멱등인 소비자(project)를 먼저, notify를 나중에(troubleshooting/0018).
      // notify job이 들어간 뒤 project addBulk가 실패하면, 트랜잭션은 롤백돼도 notify 워커가 그 행을 보내고 SENT로 바꿔
      // (relay의 행 락을 기다렸다가 롤백 뒤 커밋) 다음 relay가 그 행을 잡지 않는다 → project job이 영영 안 들어간다.
      // 반대 순서면 notify가 실패해도 행은 PENDING이라 둘 다 다시 relay되고, 먼저 들어간 project job은 jobId가 같아 한 번만
      // 들어가거나(아직 있으면) 한 번 더 돌 뿐이다(지금 상태를 다시 읽으므로 결과가 같다, decisions/0028).
      //
      // 두 번째 소비자: IN_SERVICE 진입·이탈 이벤트는 active 갱신 job도 넣는다(decisions/0028). jobId가 행마다 하나다.
      const projections = rows.filter(changesActiveSet).map((row) => ({
        name: 'project',
        data: { serialNo: (row.payload as { serialNo: string }).serialNo } satisfies ProjectJobData,
        opts: { ...PROJECT_JOB_OPTIONS, jobId: `project-${row.id}` },
      }));
      if (projections.length > 0) await this.deviceQueue.addBulk(projections);
      // jobId가 같으면 BullMQ가 한 번만 받는다(addBulk도 같다). 커밋 전에 죽어 이 행이 다시 relay돼도 job이 남아 있으면 중복으로 들어가지 않는다.
      // addBulk는 MULTI가 아니라 pipeline이라 일부만 넣고 throw할 수 있다 → 이 트랜잭션이 롤백돼 행은 PENDING, 다음 relay가 같은 jobId로 다시 넣는다(decisions/0024).
      const jobs = rows.map((row) => ({
        name: 'notify',
        data: { outboxId: row.id },
        opts: { ...NOTIFY_JOB_OPTIONS, jobId: idempotencyKeyOf(row.id) },
      }));
      if (opts.enqueue === 'each') {
        for (const job of jobs) await this.queue.add(job.name, job.data, job.opts);
      } else if (jobs.length > 0) {
        await this.queue.addBulk(jobs);
      }
      for (const row of rows) row.status = OutboxStatus.QUEUED;
      return rows.map((r) => r.id);
    }, { isolationLevel: IsolationLevel.READ_COMMITTED });
    return { queued };
  }

  /**
   * QUEUED인데 notify job이 큐에 없는 행에 같은 jobId로 job을 다시 넣는다(Day 4 이월, decisions/0042).
   * job이 사라지는 길: 처리 중인 워커가 죽은 job은 BullMQ stalled 검사가 한 번은 되살리지만, 한 job이 stalled 한도(maxStalledCount 1)를
   * 넘으면 실패로 옮겨지고 removeOnFail로 지워진다 — notify가 FAILED를 쓰지 못해 행은 QUEUED로 남는다. Redis에서 job 키가 사라져도 같다.
   * 대상: 만든 지 staleMs가 지난 QUEUED 행(id 순 limit개, (status, id) 인덱스). 행마다 job 상태를 보고 'unknown'(없음)일 때만 넣는다 —
   * 같은 jobId라 있어도 BullMQ가 받지 않지만, 실제로 몇 개가 없었는지 세려고 먼저 본다. 행은 바꾸지 않는다(QUEUED 그대로):
   * PENDING으로 되돌리면 relay가 행 락을 다시 잡고 project job까지 다시 넣는다(active 갱신은 주기 재구성이 맞춘다, decisions/0028).
   * @param opts.now 기준 시각(테스트용), opts.staleMs 기본 OUTBOX_REQUEUE_AFTER_MS
   */
  async requeueStale(opts: { staleMs?: number; limit?: number; now?: Date } = {}): Promise<{ checked: number; requeued: number[] }> {
    const now = opts.now ?? new Date();
    const staleMs = opts.staleMs ?? env.outboxRequeueAfterMs;
    const rows = await this.em.fork().find(
      OutboxEvent,
      { status: OutboxStatus.QUEUED, createdAt: { $lt: new Date(now.getTime() - staleMs) } },
      { fields: ['id'], orderBy: { id: 'asc' }, limit: opts.limit ?? 100 },
    );
    const requeued: number[] = [];
    for (const row of rows) {
      if ((await this.queue.getJobState(idempotencyKeyOf(row.id))) === 'unknown') requeued.push(row.id);
    }
    if (requeued.length > 0) {
      await this.queue.addBulk(requeued.map((id) => ({ name: 'notify', data: { outboxId: id } satisfies NotifyJobData, opts: { ...NOTIFY_JOB_OPTIONS, jobId: idempotencyKeyOf(id) } })));
    }
    return { checked: rows.length, requeued };
  }

  async notify(outboxId: number, { lastAttempt }: { lastAttempt: boolean }): Promise<'SENT' | 'SKIPPED'> {
    const em = this.em.fork();
    const row = await em.findOne(OutboxEvent, outboxId);
    if (!row || row.status === OutboxStatus.SENT || row.status === OutboxStatus.FAILED) return 'SKIPPED';

    row.attempts += 1;
    try {
      await this.toktok.send({ idempotencyKey: idempotencyKeyOf(row.id), text: textOf(row) });
    } catch (error) {
      const permanent = error instanceof PartnerPermanentError;
      row.lastError = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
      if (permanent || lastAttempt) row.status = OutboxStatus.FAILED;
      await em.flush();
      throw permanent ? new UnrecoverableError(row.lastError) : error;
    }
    // 여기서 죽으면(메신저는 받았는데 SENT를 못 씀) job이 다시 실행돼 한 번 더 보낸다 → 멱등키로 메신저가 걸러야 한다.
    row.status = OutboxStatus.SENT;
    row.sentAt = new Date();
    row.lastError = null;
    await em.flush();
    return 'SENT';
  }
}
