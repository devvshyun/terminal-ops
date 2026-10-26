import { OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, Enum, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalModel } from '../terminal/terminal-model.entity.js';

/** 등록된 펌웨어(모델별 버전). 단말기 상태 enum과 무관하다(decisions/0030). */
@Entity({ tableName: 'firmware' })
@Unique({ properties: ['model', 'version'] })
export class Firmware {
  [OptionalProps]?: 'createdAt';

  @PrimaryKey()
  id!: number;

  // FK 열 단독 인덱스를 만들지 않는다: unique(model_id, version)이 이 열로 시작해 FK 검사·조회를 대신한다(decisions/0032)
  @ManyToOne(() => TerminalModel, { index: false })
  model!: Rel<TerminalModel>;

  @Property({ length: 20 })
  version!: string;

  @Property({ length: 50 })
  createdBy!: string;

  @Property()
  createdAt: Date = new Date();
}

export enum RolloutStatus {
  RUNNING = 'RUNNING', // 단계 진행 중
  PAUSED = 'PAUSED', // 운영자가 멈춤(제안 내림, 단계 넘기지 않음)
  COMPLETED = 'COMPLETED', // 마지막 단계까지 끝
  ABORTED = 'ABORTED', // 실패율 초과로 자동 중단, 또는 운영자 중단
}

/** 아직 끝나지 않은 배포. 모델마다 하나만 있을 수 있다 */
export const ACTIVE_ROLLOUT_STATUSES = [RolloutStatus.RUNNING, RolloutStatus.PAUSED];

/**
 * 펌웨어 단계 배포(F8). stages는 단계별 **누적** 비율(%)이다(예 [10, 50, 100]).
 * 이 행이 배포의 잠금 단위다 — 단계 넘기기·중단·멈춤은 모두 이 행을 FOR UPDATE로 잡고 한다(decisions/0031).
 */
@Entity({ tableName: 'firmware_rollout' })
@Index({ properties: ['status'] })
export class FirmwareRollout {
  [OptionalProps]?: 'currentStage' | 'status' | 'stageStartedAt' | 'createdAt' | 'finishedAt' | 'endReason';

  @PrimaryKey()
  id!: number;

  @ManyToOne(() => Firmware)
  firmware!: Rel<Firmware>;

  @Property({ type: 'json' })
  stages!: number[];

  /** 지금 단계(stages의 위치, 0부터) */
  @Property()
  currentStage: number = 0;

  @Enum({ items: () => RolloutStatus })
  status: RolloutStatus = RolloutStatus.RUNNING;

  /** 이 비율을 넘게 실패하면 자동 중단(0~1, 예 0.2) */
  @Property({ type: 'double' })
  failureThreshold!: number;

  /** 결과가 이만큼 모이기 전에는 실패율로 중단하지 않는다(단계가 다 끝났으면 예외) */
  @Property()
  minSamples!: number;

  /** 단계 안에서 제안 뒤 이 시간이 지나도록 보고가 없으면 TIMED_OUT */
  @Property()
  stageTimeoutMs!: number;

  @Property({ type: 'datetime', length: 3 })
  stageStartedAt: Date = new Date();

  @Property({ length: 50 })
  createdBy!: string;

  @Property()
  createdAt: Date = new Date();

  @Property({ type: 'datetime', nullable: true })
  finishedAt: Date | null = null;

  /** 끝난 이유(자동 중단 사유, 운영자 중단 등) */
  @Property({ type: 'varchar', length: 200, nullable: true })
  endReason: string | null = null;
}

export enum TargetStatus {
  OFFERED = 'OFFERED', // 제안함, 보고 기다림
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  TIMED_OUT = 'TIMED_OUT', // 단계 시간 안에 보고가 없음
}

/** 배포 대상 단말기 한 대. 단계에 들어갈 때 만든다. */
@Entity({ tableName: 'firmware_rollout_target' })
@Unique({ properties: ['rollout', 'terminal'] })
@Index({ properties: ['rollout', 'stage', 'status'] })
export class FirmwareRolloutTarget {
  [OptionalProps]?: 'status' | 'offeredAt' | 'reportedAt' | 'reportedVersion';

  @PrimaryKey()
  id!: number;

  // FK 열 단독 인덱스를 만들지 않는다: unique(rollout_id, terminal_id)이 이 열로 시작해 FK 검사·조회를 대신한다(decisions/0032)
  @ManyToOne(() => FirmwareRollout, { index: false })
  rollout!: Rel<FirmwareRollout>;

  @ManyToOne(() => Terminal)
  terminal!: Rel<Terminal>;

  /** 이 단말기가 들어간 단계 */
  @Property()
  stage!: number;

  @Enum({ items: () => TargetStatus })
  status: TargetStatus = TargetStatus.OFFERED;

  @Property({ type: 'datetime', length: 3 })
  offeredAt: Date = new Date();

  @Property({ type: 'datetime', length: 3, nullable: true })
  reportedAt: Date | null = null;

  /** 단말기가 보고한 버전 */
  @Property({ type: 'varchar', length: 20, nullable: true })
  reportedVersion: string | null = null;
}
