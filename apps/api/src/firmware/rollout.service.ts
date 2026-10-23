import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { BusinessError } from '../common/domain-errors.js';
import { OfferStore } from '../device/offer-store.js';
import { OUTBOX_TYPE, OutboxEvent } from '../outbox/outbox-event.entity.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalModel } from '../terminal/terminal-model.entity.js';
import type { CreateRolloutDto } from './dto/firmware.dto.js';
import { ACTIVE_ROLLOUT_STATUSES, Firmware, FirmwareRollout, FirmwareRolloutTarget, RolloutStatus, TargetStatus } from './firmware.entities.js';

/** 단계 제한 시간 기본값(10분) */
export const DEFAULT_STAGE_TIMEOUT_MS = 10 * 60_000;

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
    await this.offers.publish(offered, { rolloutId: id, version: firmware.version });
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
    const { serials, version } = await this.em.fork().transactional(async (tx) => {
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
      return { serials: offered.map((t) => t.serialNo), version: rollout.firmware.version };
    });
    await this.offers.publish(serials, { rolloutId: id, version });
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
   * 단말기 행을 바꾸지 않으므로 S→X 승격이 없다. @returns 새로 제안할 시리얼(커밋 뒤 Redis에 건다)
   */
  private async enterStage(tx: EntityManager, rollout: FirmwareRollout, modelId: number, stage: number, now: Date): Promise<string[]> {
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
    const picked = candidates.slice(0, Math.max(0, want));
    for (const c of picked) {
      tx.create(FirmwareRolloutTarget, { rollout, terminal: tx.getReference(Terminal, c.id), stage, offeredAt: now });
    }
    rollout.currentStage = stage;
    rollout.stageStartedAt = now;
    await tx.flush();
    return picked.map((c) => c.serial_no);
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

  /** 아직 보고가 없는 대상(id 순). 잠그지 않고 읽는다 — 대상 행은 PK로만 갱신한다 */
  private async offeredTargets(tx: EntityManager, rolloutId: number): Promise<{ id: number; serialNo: string; offeredAt: Date }[]> {
    const rows = await tx.execute<{ id: number; serial_no: string; offered_at: Date }[]>(
      `select r.id, t.serial_no, r.offered_at from firmware_rollout_target r join terminal t on t.id = r.terminal_id
        where r.rollout_id = ? and r.status = 'OFFERED' order by r.id`,
      [rolloutId],
    );
    return rows.map((r) => ({ id: r.id, serialNo: r.serial_no, offeredAt: new Date(r.offered_at) }));
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
