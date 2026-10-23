import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { fromDbDatetime } from '../common/db-datetime.js';
import { BusinessError } from '../common/domain-errors.js';
import { OfferStore } from '../device/offer-store.js';
import { OUTBOX_TYPE, OutboxEvent } from '../outbox/outbox-event.entity.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalModel } from '../terminal/terminal-model.entity.js';
import type { CreateRolloutDto } from './dto/firmware.dto.js';
import { ACTIVE_ROLLOUT_STATUSES, Firmware, FirmwareRollout, FirmwareRolloutTarget, RolloutStatus, TargetStatus } from './firmware.entities.js';

/** 제안을 건 뒤 상태를 다시 읽을 때 한 번에 묻는 대상 수 */
const RECHECK_CHUNK = 1000;

/** 단계 제한 시간 기본값(10분) */
export const DEFAULT_STAGE_TIMEOUT_MS = 10 * 60_000;

export type ControlAction = 'NONE' | 'WAITING' | 'ADVANCED' | 'COMPLETED' | 'ABORTED' | 'ERROR';

export interface ControlResult {
  rolloutId: number;
  action: ControlAction;
  /** 판단한 단계(넘어갔으면 새 단계). ERROR면 -1(판단하지 못함) */
  stage: number;
  /** 이번에 제한 시간이 지나 TIMED_OUT으로 바꾼 대상 수(실제로 바뀐 행 수) */
  timedOut: number;
  /** ERROR일 때 오류 메시지 */
  error?: string;
}

/** 제안을 걸 대상 한 건(대상 행 id는 건 뒤 상태를 다시 확인하는 데 쓴다) */
interface OfferTarget {
  id: number;
  serialNo: string;
}

/** 보고를 기다리는 대상 한 건(offeredTargets) */
interface OfferedTarget {
  id: number;
  serialNo: string;
  stage: number;
  offeredAt: Date;
  /** 단말기가 지금 운영 중(IN_SERVICE)인지. 아니면 응답할 수 없어 시간 초과·실패율에서 뺀다 */
  inService: boolean;
}

export interface StageStats {
  stage: number;
  percent: number;
  targets: number;
  offered: number;
  succeeded: number;
  failed: number;
  timedOut: number;
}

/** 단계 비율은 1~100, 커지는 순서, 마지막은 100 */
export function checkStages(stages: number[]): string | null {
  if (stages.some((p, i) => i > 0 && p <= stages[i - 1])) return 'stages는 커지는 순서여야 합니다(누적 비율).';
  if (stages.at(-1) !== 100) return 'stages의 마지막은 100이어야 합니다.';
  return null;
}

/**
 * 펌웨어 단계 배포(F8, decisions/0030). 단계에 들어갈 때 대상 단말기를 고르고(해당 모델의 운영 중 단말기, 시리얼 CRC32 순 —
 * 같은 단말기 목록이면 늘 같은 순서) 대상 행을 만든 뒤, **커밋 뒤에** Redis에 제안을 건다(하트비트 응답의 빠른 길).
 * 배포 행이 잠금 단위다: 만들기는 모델 행, 나머지(멈춤·재개·중단, 단계 넘기기)는 배포 행을 FOR UPDATE로 먼저 잡는다(decisions/0031).
 */
@Injectable()
export class RolloutService {
  private readonly logger = new Logger(RolloutService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly offers: OfferStore,
  ) {}

  async create(dto: CreateRolloutDto, actor: string): Promise<FirmwareRollout> {
    const invalid = checkStages(dto.stages);
    if (invalid) throw new BadRequestException({ statusCode: 400, code: 'INVALID_STAGES', message: invalid });
    const firmware = await this.em.fork().findOne(Firmware, { model: { code: dto.modelCode }, version: dto.version }, { populate: ['model'] });
    if (!firmware) throw new NotFoundException(`펌웨어 ${dto.modelCode} ${dto.version}이(가) 등록되지 않았습니다.`);

    const { id, offered } = await this.em.fork().transactional(async (tx) => {
      // 모델 행을 먼저 잠가 같은 모델의 배포 만들기를 줄 세운다. 잠근 뒤에 센 "진행 중 배포"라야 동시에 둘이 생기지 않는다.
      // 이 FOR UPDATE는 반드시 트랜잭션의 첫 문장이어야 한다. RR에서 스냅숏(read view)은 첫 일반 SELECT에서 만들어진다(FOR UPDATE는
      // 만들지 않는다). 잠금 앞에 일반 SELECT를 하나라도 두면 스냅숏이 잠금 전으로 고정되어, 아래 count가 앞 트랜잭션이 커밋한 배포를
      // 보지 못하고 둘이 생길 수 있다. 펌웨어 조회를 트랜잭션 밖(위)에 둔 것도 그래서다(decisions/0031).
      await tx.findOneOrFail(TerminalModel, firmware.model.id, { lockMode: LockMode.PESSIMISTIC_WRITE });
      const active = await tx.count(FirmwareRollout, { firmware: { model: firmware.model.id }, status: { $in: ACTIVE_ROLLOUT_STATUSES } });
      if (active > 0) throw new BusinessError(409, 'ROLLOUT_ALREADY_ACTIVE', `모델 ${dto.modelCode}에 진행 중인 펌웨어 배포가 있습니다.`);
      const rollout = tx.create(FirmwareRollout, {
        firmware: tx.getReference(Firmware, firmware.id),
        stages: dto.stages,
        failureThreshold: dto.failureThreshold,
        minSamples: dto.minSamples,
        stageTimeoutMs: dto.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS,
        createdBy: actor,
      });
      await tx.flush();
      return { id: rollout.id, offered: await this.enterStage(tx, rollout, firmware.model.id, 0, new Date()) };
    });
    await this.publishOffers(id, firmware.version, offered);
    return this.get(id);
  }

  /** 멈춤: 단계를 넘기지 않고, 하트비트 제안을 내린다. 이미 받은 단말기의 보고는 그대로 받는다. */
  async pause(id: number): Promise<FirmwareRollout> {
    const serials = await this.em.fork().transactional(async (tx) => {
      const rollout = await this.lockRollout(tx, id);
      if (rollout.status !== RolloutStatus.RUNNING) throw this.wrongStatus(rollout, 'ROLLOUT_NOT_RUNNING');
      rollout.status = RolloutStatus.PAUSED;
      return (await this.offeredTargets(tx, id)).map((t) => t.serialNo);
    });
    await this.offers.withdraw(id, serials);
    return this.get(id);
  }

  /** 재개: 아직 보고하지 않은 대상의 제안 시각을 지금으로 다시 잡고(멈춘 동안은 제한 시간에 넣지 않는다) 제안을 다시 건다. */
  async resume(id: number): Promise<FirmwareRollout> {
    const { targets, version } = await this.em.fork().transactional(async (tx) => {
      const rollout = await this.lockRollout(tx, id);
      if (rollout.status !== RolloutStatus.PAUSED) throw this.wrongStatus(rollout, 'ROLLOUT_NOT_PAUSED');
      const now = new Date();
      rollout.status = RolloutStatus.RUNNING;
      rollout.stageStartedAt = now;
      const offered = await this.offeredTargets(tx, id);
      // 대상 행은 PK로 갱신한다(보조 인덱스 범위 UPDATE의 gap 락을 피한다, troubleshooting/0014)
      if (offered.length > 0) {
        await tx.nativeUpdate(FirmwareRolloutTarget, { id: { $in: offered.map((t) => t.id) }, status: TargetStatus.OFFERED }, { offeredAt: now });
      }
      return { targets: offered, version: rollout.firmware.version };
    });
    await this.publishOffers(id, version, targets);
    return this.get(id);
  }

  /** 운영자 중단 */
  async abort(id: number, actor: string): Promise<FirmwareRollout> {
    const serials = await this.em.fork().transactional(async (tx) => {
      const rollout = await this.lockRollout(tx, id);
      if (!ACTIVE_ROLLOUT_STATUSES.includes(rollout.status)) throw this.wrongStatus(rollout, 'ROLLOUT_FINISHED');
      this.finish(tx, rollout, RolloutStatus.ABORTED, `운영자 중단: ${actor}`);
      return (await this.offeredTargets(tx, id)).map((t) => t.serialNo);
    });
    await this.offers.withdraw(id, serials);
    return this.get(id);
  }

  /**
   * 주기 작업(rollout-control)이 부른다. ① 진행 중(RUNNING)인 배포마다 control(배포마다 따로 트랜잭션, 남은 제안을 다시 건다)
   * ② Redis에 남은 제안 중 진행 중이 아닌 배포(멈춤·끝남·없음)의 것을 내린다(withdrawStaleOffers).
   * ①②가 합쳐 Redis 제안을 MySQL(OFFERED)에 다시 맞춘다 — 커밋 뒤 Redis 작업이 빠지거나(그 사이 죽음) 순서가 뒤바뀌어도
   * (멈춤·재개·중단이 겹침) 한 주기 안에 고쳐진다(decisions/0031).
   * 배포 하나의 판단이 실패해도(데드락·Redis 오류 등) 그 배포만 ERROR로 남기고 다음 배포와 ②를 한다. 그 배포는 다음 주기에 다시 판단한다.
   */
  async controlAll(now = new Date()): Promise<ControlResult[]> {
    const results: ControlResult[] = [];
    try {
      const running = await this.em.fork().find(FirmwareRollout, { status: RolloutStatus.RUNNING }, { fields: ['id'], orderBy: { id: 'asc' } });
      for (const r of running) {
        try {
          results.push(await this.control(r.id, now));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`배포 ${r.id} 판단 실패(다음 주기에 다시): ${message}`, err instanceof Error ? err.stack : undefined);
          results.push({ rolloutId: r.id, action: 'ERROR', stage: -1, timedOut: 0, error: message });
        }
      }
    } finally {
      await this.withdrawStaleOffers();
    }
    return results;
  }

  /**
   * Redis 제안 중 진행 중(RUNNING)이 아닌 배포의 것을 내린다(배포 id 비교 Lua라 그사이 같은 단말기에 걸린 다른 배포의 제안은 남는다).
   * Redis를 훑으므로(HSCAN) 끝난 배포가 쌓여도 일은 지금 걸린 제안 수만큼이다. @returns 내린 수
   * 상태를 읽은 뒤 재개가 커밋하고 제안을 다시 걸면 여기서 내릴 수 있다 — 그 배포는 RUNNING이라 다음 control이 다시 건다.
   */
  async withdrawStaleOffers(): Promise<number> {
    const byRollout = await this.offers.byRollout();
    if (byRollout.size === 0) return 0;
    const running = await this.em.fork().find(FirmwareRollout, { id: { $in: [...byRollout.keys()] }, status: RolloutStatus.RUNNING }, { fields: ['id'] });
    const keep = new Set(running.map((r) => r.id));
    let removed = 0;
    for (const [rolloutId, serials] of byRollout) {
      if (!keep.has(rolloutId)) removed += await this.offers.withdraw(rolloutId, serials);
    }
    return removed;
  }

  /**
   * 배포 한 건을 한 번 판단한다(decisions/0031). 잠금 순서: ① 배포 행 FOR UPDATE ② 대상 행(PK로 갱신·새로 INSERT).
   * 보고 API는 대상 행 하나만 PK로 바꾸고 배포 행은 잠그지 않는다 — 보고는 배포 행을 기다리지 않고, 순환 대기가 생기지 않는다.
   * 여러 프로세스가 동시에 불러도 배포 행 잠금에서 줄을 서고, 뒤에 온 쪽은 앞쪽이 바꾼 상태(새 단계 등)를 보고 판단한다.
   * 1. 지금 단계의 OFFERED 중 제한 시간이 지난 것 → TIMED_OUT(id 순, PK 갱신). 단, 단말기가 운영 중(IN_SERVICE)이 아니면 응답할 수 없으니
   *    TIMED_OUT으로 바꾸지 않고 OFFERED로 남긴 채 실패율·남은 대상에서 뺀다(제외. 제안만 내리고, 늦은 보고는 그대로 받는다).
   * 2. 실패율 = (FAILED + TIMED_OUT) / (SUCCEEDED + FAILED + TIMED_OUT). 기준을 넘고, 결과가 minSamples 이상이거나 단계가 다 끝났으면
   *    → ABORTED(Outbox 알림), 남은 제안을 모두 내린다.
   * 3. 남은 대상(제한 시간 안의 OFFERED)이 없으면 다음 단계(대상 INSERT, 알림) 또는 마지막 단계면 COMPLETED(알림).
   * Redis 제안 걸기·내리기는 커밋 뒤에 한다(트랜잭션 안에서 외부 저장소를 기다리지 않는다). 계속 진행하면(WAITING·ADVANCED) 남은 대상의
   * 제안을 매번 다시 건다(HSET은 같은 값이면 그대로) — 걸기 전에 죽었거나 늦게 온 내리기에 지워진 제안을 다음 주기가 되살린다.
   * 다시 건 뒤에는 그 대상들의 상태를 다시 읽어 그사이 보고된 것의 제안을 내린다(publishOffers, troubleshooting/0019).
   * TIMED_OUT으로 바뀐 행 수가 고른 수보다 적으면(스냅숏 뒤에 보고가 커밋됨) 이번 주기는 판단하지 않고 WAITING으로 둔다 —
   * 통계는 스냅숏이라 그 보고를 OFFERED로 세고, 남은 대상에서는 빠져 있어 그 보고가 어디에도 세이지 않은 채 단계가 넘어갈 수 있다.
   */
  async control(id: number, now = new Date()): Promise<ControlResult> {
    const { result, publish, withdraw, version } = await this.em.fork().transactional(async (tx) => {
      const rollout = await this.lockRollout(tx, id);
      const version = rollout.firmware.version;
      const base = { rolloutId: id, stage: rollout.currentStage, timedOut: 0 };
      if (rollout.status !== RolloutStatus.RUNNING) return { result: { ...base, action: 'NONE' as const }, publish: [], withdraw: [], version };

      const offered = (await this.offeredTargets(tx, id)).filter((t) => t.stage === rollout.currentStage);
      const isExpired = (t: OfferedTarget) => t.offeredAt.getTime() + rollout.stageTimeoutMs <= now.getTime();
      const expired = offered.filter((t) => isExpired(t) && t.inService);
      // 운영에서 빠진 단말기: 시간 초과로 세지 않고(OFFERED 유지) 남은 대상에서도 뺀다
      const excluded = offered.filter((t) => isExpired(t) && !t.inService);
      const waiting = offered.filter((t) => !isExpired(t));
      let changed = 0;
      if (expired.length > 0) {
        changed = await tx.nativeUpdate(
          FirmwareRolloutTarget,
          { id: { $in: expired.map((t) => t.id) }, status: TargetStatus.OFFERED },
          { status: TargetStatus.TIMED_OUT },
        );
      }
      const timedOut = { ...base, timedOut: changed };
      const expiredSerials = [...expired, ...excluded].map((t) => t.serialNo);
      // UPDATE는 지금 값(current read)을 보고, 아래 통계는 스냅숏을 본다. 덜 바뀌었다면 스냅숏 뒤에 커밋된 보고가 있다:
      // 그 보고는 통계에서는 OFFERED, 남은 대상(waiting)에서는 빠져 어디에도 세이지 않는다. 이번 주기는 판단을 미루고 다음 주기(새 스냅숏)에 센다.
      // 바뀐 TIMED_OUT은 그대로 커밋한다(그 대상은 정말 시간 초과다). 보고된 대상의 제안은 보고 API가 커밋 뒤에 내린다.
      if (changed < expired.length) {
        return { result: { ...timedOut, action: 'WAITING' as const }, publish: waiting, withdraw: expiredSerials, version };
      }
      const s = (await this.stageStats(rollout, tx))[rollout.currentStage];
      const failures = s.failed + s.timedOut;
      const decided = s.succeeded + failures;

      if (decided > 0 && failures / decided > rollout.failureThreshold && (decided >= rollout.minSamples || waiting.length === 0)) {
        const pct = (n: number) => Math.round(n * 1000) / 10;
        this.finish(
          tx,
          rollout,
          RolloutStatus.ABORTED,
          `자동 중단: ${rollout.currentStage + 1}단계 실패율 ${pct(failures / decided)}% (${failures}/${decided}) > 기준 ${pct(rollout.failureThreshold)}%`,
        );
        const remaining = (await this.offeredTargets(tx, id)).map((t) => t.serialNo);
        return { result: { ...timedOut, action: 'ABORTED' as const }, publish: [], withdraw: [...expiredSerials, ...remaining], version };
      }
      if (waiting.length > 0) {
        return { result: { ...timedOut, action: 'WAITING' as const }, publish: waiting, withdraw: expiredSerials, version };
      }
      if (rollout.currentStage === rollout.stages.length - 1) {
        this.finish(tx, rollout, RolloutStatus.COMPLETED, '마지막 단계 완료');
        // 앞 단계에서 제외된 대상(OFFERED로 남음)의 제안도 남지 않게 모두 내린다
        const remaining = (await this.offeredTargets(tx, id)).map((t) => t.serialNo);
        return { result: { ...timedOut, action: 'COMPLETED' as const }, publish: [], withdraw: [...expiredSerials, ...remaining], version };
      }
      const next = rollout.currentStage + 1;
      const fresh = await this.enterStage(tx, rollout, rollout.firmware.model.id, next, now);
      tx.create(OutboxEvent, {
        type: OUTBOX_TYPE.FIRMWARE_STAGE_ADVANCED,
        payload: { rolloutId: id, version, stage: next, percent: rollout.stages[next], targets: fresh.length },
      });
      return { result: { ...timedOut, stage: next, action: 'ADVANCED' as const }, publish: fresh, withdraw: expiredSerials, version };
    });
    if (withdraw.length > 0) await this.offers.withdraw(id, withdraw);
    await this.publishOffers(id, version, publish);
    return result;
  }

  /**
   * 커밋 뒤 제안을 걸고, 건 대상들의 상태를 PK로 다시 읽어(트랜잭션 밖 autocommit, 지금 값) OFFERED가 아닌 것의 제안을 내린다(배포 id 비교 Lua).
   * 판단의 스냅숏 뒤에 보고가 커밋되고 제안을 내렸는데 판단의 다시 걸기가 그 뒤에 도착하면, 이미 보고한(실패한) 단말기에
   * 같은 버전이 다시 권해진다(troubleshooting/0019). 보고는 커밋한 뒤에 내리므로 "걸기 → 다시 읽기" 순서면 둘 중 하나가 꼭 지운다:
   * 보고의 커밋이 다시 읽기보다 앞이면 여기서 지우고, 뒤면 보고의 내리기가 걸기보다 뒤에 온다.
   * 대상 행은 OFFERED에서 한 번 벗어나면 돌아오지 않고, 한 배포에 단말기는 한 번만 대상이라 이 내리기가 새 단계 제안을 지우지 않는다.
   */
  private async publishOffers(rolloutId: number, version: string, targets: OfferTarget[]): Promise<void> {
    if (targets.length === 0) return;
    await this.offers.publish(
      targets.map((t) => t.serialNo),
      { rolloutId, version },
    );
    const serialOf = new Map(targets.map((t) => [t.id, t.serialNo]));
    const ids = [...serialOf.keys()];
    const em = this.em.fork();
    const reported: string[] = [];
    for (let i = 0; i < ids.length; i += RECHECK_CHUNK) {
      const rows = await em.find(
        FirmwareRolloutTarget,
        { id: { $in: ids.slice(i, i + RECHECK_CHUNK) }, status: { $ne: TargetStatus.OFFERED } },
        { fields: ['id'] },
      );
      for (const r of rows) reported.push(serialOf.get(r.id)!);
    }
    if (reported.length > 0) await this.offers.withdraw(rolloutId, reported);
  }

  async get(id: number): Promise<FirmwareRollout> {
    const rollout = await this.em.fork().findOne(FirmwareRollout, id, { populate: ['firmware.model'] });
    if (!rollout) throw new NotFoundException(`펌웨어 배포 ${id}이(가) 없습니다.`);
    return rollout;
  }

  /** 단계별 대상 수와 결과 수 */
  async stageStats(rollout: FirmwareRollout, em: EntityManager = this.em.fork()): Promise<StageStats[]> {
    const rows: { stage: number; status: TargetStatus; c: number | string }[] = await em.execute(
      'select stage, status, count(*) as c from firmware_rollout_target where rollout_id = ? group by stage, status',
      [rollout.id],
    );
    return rollout.stages.map((percent, stage) => {
      const of = (status: TargetStatus) => Number(rows.find((r) => r.stage === stage && r.status === status)?.c ?? 0);
      const s = { offered: of(TargetStatus.OFFERED), succeeded: of(TargetStatus.SUCCEEDED), failed: of(TargetStatus.FAILED), timedOut: of(TargetStatus.TIMED_OUT) };
      return { stage, percent, targets: s.offered + s.succeeded + s.failed + s.timedOut, ...s };
    });
  }

  /**
   * 단계에 들어간다: 이 모델의 운영 중 단말기 중 아직 대상이 아닌 것을 CRC32(시리얼) 순으로 골라, 누적 비율에 모자란 만큼 대상 행을 만든다.
   * 모수는 (이미 대상 + 아직 대상 아닌 운영 중 단말기)다. 대상 행 INSERT의 FK 검사는 단말기 행에 S 락을 거는데, 이 트랜잭션은
   * 단말기 행을 바꾸지 않으므로 S→X 승격이 없다. 고르는 순서는 CRC32지만 INSERT는 단말기 id 순으로 한다(FK 검사의 S 락을
   * 다른 경로처럼 id 순으로 잡아 교착 가능성을 줄인다. 고른 집합은 같다). @returns 새로 제안할 대상(커밋 뒤 Redis에 건다)
   */
  private async enterStage(tx: EntityManager, rollout: FirmwareRollout, modelId: number, stage: number, now: Date): Promise<OfferTarget[]> {
    const [{ targeted }] = await tx.execute<{ targeted: number | string }[]>(
      'select count(*) as targeted from firmware_rollout_target where rollout_id = ?',
      [rollout.id],
    );
    const candidates = await tx.execute<{ id: number; serial_no: string }[]>(
      `select t.id, t.serial_no from terminal t
        where t.model_id = ? and t.status = 'IN_SERVICE'
          and not exists (select 1 from firmware_rollout_target r where r.rollout_id = ? and r.terminal_id = t.id)
        order by crc32(t.serial_no), t.id`,
      [modelId, rollout.id],
    );
    const already = Number(targeted);
    const want = Math.ceil(((already + candidates.length) * rollout.stages[stage]) / 100) - already;
    const picked = candidates.slice(0, Math.max(0, want)).sort((a, b) => Number(a.id) - Number(b.id));
    const created = picked.map((c) => ({
      serialNo: c.serial_no,
      target: tx.create(FirmwareRolloutTarget, { rollout, terminal: tx.getReference(Terminal, c.id), stage, offeredAt: now }),
    }));
    rollout.currentStage = stage;
    rollout.stageStartedAt = now;
    await tx.flush();
    return created.map((c) => ({ id: c.target.id, serialNo: c.serialNo }));
  }

  /** 배포를 끝낸다(완료·중단). 알림은 같은 트랜잭션의 Outbox로 */
  private finish(tx: EntityManager, rollout: FirmwareRollout, status: RolloutStatus.COMPLETED | RolloutStatus.ABORTED, reason: string): void {
    rollout.status = status;
    rollout.finishedAt = new Date();
    rollout.endReason = reason;
    tx.create(OutboxEvent, {
      type: status === RolloutStatus.COMPLETED ? OUTBOX_TYPE.FIRMWARE_ROLLOUT_COMPLETED : OUTBOX_TYPE.FIRMWARE_ROLLOUT_ABORTED,
      payload: { rolloutId: rollout.id, version: rollout.firmware.version, stage: rollout.currentStage, reason },
    });
  }

  private async lockRollout(tx: EntityManager, id: number): Promise<FirmwareRollout> {
    const rollout = await tx.findOne(FirmwareRollout, id, { lockMode: LockMode.PESSIMISTIC_WRITE, populate: ['firmware'] });
    if (!rollout) throw new NotFoundException(`펌웨어 배포 ${id}이(가) 없습니다.`);
    return rollout;
  }

  /** 아직 보고가 없는 대상(id 순)과 그 단말기가 지금 운영 중인지. 잠그지 않고 읽는다 — 대상 행은 PK로만 갱신한다 */
  private async offeredTargets(tx: EntityManager, rolloutId: number): Promise<OfferedTarget[]> {
    const rows = await tx.execute<{ id: number; serial_no: string; stage: number; offered_at: string; in_service: number | string }[]>(
      `select r.id, t.serial_no, r.stage, r.offered_at, t.status = 'IN_SERVICE' as in_service
         from firmware_rollout_target r join terminal t on t.id = r.terminal_id
        where r.rollout_id = ? and r.status = 'OFFERED' order by r.id`,
      [rolloutId],
    );
    return rows.map((r) => ({
      id: r.id,
      serialNo: r.serial_no,
      stage: r.stage,
      offeredAt: fromDbDatetime(r.offered_at),
      inService: Number(r.in_service) === 1,
    }));
  }

  private wrongStatus(rollout: FirmwareRollout, code: string): BusinessError {
    return new BusinessError(422, code, `펌웨어 배포 ${rollout.id}은(는) ${rollout.status} 상태라 이 작업을 할 수 없습니다.`);
  }
}

export function toRolloutView(rollout: FirmwareRollout, stats: StageStats[]) {
  return {
    id: rollout.id,
    modelCode: rollout.firmware.model.code,
    version: rollout.firmware.version,
    status: rollout.status,
    stages: rollout.stages,
    currentStage: rollout.currentStage,
    failureThreshold: rollout.failureThreshold,
    minSamples: rollout.minSamples,
    stageTimeoutMs: rollout.stageTimeoutMs,
    stageStartedAt: rollout.stageStartedAt.toISOString(),
    createdBy: rollout.createdBy,
    createdAt: rollout.createdAt.toISOString(),
    finishedAt: rollout.finishedAt?.toISOString() ?? null,
    endReason: rollout.endReason,
    stageStats: stats,
  };
}
