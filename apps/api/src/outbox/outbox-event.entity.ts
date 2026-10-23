import { OptionalProps } from '@mikro-orm/core';
import { Entity, Enum, Index, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

export enum OutboxStatus {
  PENDING = 'PENDING', // 기록됨, 아직 큐에 안 넣음
  QUEUED = 'QUEUED', // 알림 job을 큐에 넣음
  SENT = 'SENT', // 메신저가 200을 줌
  FAILED = 'FAILED', // 재시도를 다 써도 실패
}

export const OUTBOX_TYPE = {
  TERMINAL_STATUS_CHANGED: 'terminal.status_changed',
  /** 접속 상태(F8). 상태 전이가 아니라 별도 type이다(decisions/0029) */
  DEVICE_OFFLINE: 'device.offline',
  DEVICE_ONLINE: 'device.online',
  /** 한 번 판정에서 기준보다 많이 바뀌면 묶음 한 건(decisions/0029) */
  DEVICE_OFFLINE_BULK: 'device.offline_bulk',
  DEVICE_ONLINE_BULK: 'device.online_bulk',
  /** 펌웨어 배포(F8, decisions/0030·0031) */
  FIRMWARE_STAGE_ADVANCED: 'firmware.stage_advanced',
  FIRMWARE_ROLLOUT_COMPLETED: 'firmware.rollout_completed',
  FIRMWARE_ROLLOUT_ABORTED: 'firmware.rollout_aborted',
} as const;

/**
 * 보낼 알림. 상태 변경과 같은 트랜잭션에서 기록하고(유실 없음), relay가 나중에 큐로 옮긴다(decisions/0016).
 * 외래키를 두지 않는다 — 부모 행 락을 잡지 않고, 단말기를 지워도 알림 기록은 남게 하기 위해서다.
 */
@Entity({ tableName: 'outbox_event' })
@Index({ properties: ['status', 'id'] })
export class OutboxEvent {
  [OptionalProps]?: 'status' | 'attempts' | 'createdAt';

  @PrimaryKey()
  id!: number;

  @Property({ length: 50 })
  type!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Enum({ items: () => OutboxStatus })
  status: OutboxStatus = OutboxStatus.PENDING;

  /** 전송 시도 횟수 */
  @Property()
  attempts: number = 0;

  @Property({ length: 500, nullable: true })
  lastError?: string | null;

  @Property()
  createdAt: Date = new Date();

  // 유니온 타입(Date | null)은 데코레이터 메타데이터가 Object라 type을 꼭 적는다(varchar(255)가 되는 것을 막는다).
  @Property({ type: 'datetime', nullable: true })
  sentAt?: Date | null;
}
