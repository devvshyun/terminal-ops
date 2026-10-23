import { OptionalProps } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/**
 * 단말기 접속 상태의 MySQL 스냅샷(F8). 원본(최신값)은 Redis(lastSeen·firmware)이고, 이 표는
 * ① 온라인↔오프라인이 바뀐 순간(오프라인 판정 job)과 ② 주기 스냅샷 job이 한꺼번에 쓴다. 하트비트마다 쓰지 않는다(decisions/0027·0029).
 * 상태 전이가 아니므로 terminal.status·이력과 무관하다.
 * terminal_id에 외래키를 두지 않는다 — 수천 행을 한 번에 UPSERT할 때 단말기 행마다 FK 검사 S 락을 걸지 않게(Outbox와 같은 이유).
 */
@Entity({ tableName: 'device_connectivity' })
export class DeviceConnectivity {
  [OptionalProps]?: 'firmwareVersion';

  /** terminal.id */
  @PrimaryKey({ autoincrement: false })
  terminalId!: number;

  @Property()
  online!: boolean;

  /** 마지막 하트비트(서버 시계, 밀리초까지) */
  @Property({ type: 'datetime', length: 3 })
  lastSeenAt!: Date;

  @Property({ type: 'varchar', length: 20, nullable: true })
  firmwareVersion: string | null = null;

  /** online 값이 마지막으로 바뀐 시각(오프라인 판정 job이 쓴다) */
  @Property({ type: 'datetime', length: 3 })
  changedAt!: Date;
}
