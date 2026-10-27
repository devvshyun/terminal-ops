import { OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, Enum, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';
import { Carrier, CarrierEventCode } from '../carrier/carrier.types.js';
import { Terminal } from '../terminal/terminal.entity.js';

export enum ShipmentStatus {
  IN_TRANSIT = 'IN_TRANSIT',
  DELIVERED = 'DELIVERED',
  /** 같은 단말기를 다시 출고해 더는 이 운송장으로 단말기 상태를 바꾸지 않는다(decisions/0018). */
  SUPERSEDED = 'SUPERSEDED',
}

// 주의: `Date | null` 같은 유니온 타입은 데코레이터 메타데이터가 Object로 나와 MikroORM이 varchar(255)로 만든다.
// nullable 날짜에는 type: 'datetime'을 꼭 적는다.

/** 출고 1건 = 운송장 1장. 수집 작업이 IN_TRANSIT인 운송장을 주기적으로 조회한다. */
@Entity({ tableName: 'shipment' })
@Index({ properties: ['status'] })
export class Shipment {
  [OptionalProps]?: 'status' | 'createdAt';

  @PrimaryKey()
  id!: number;

  @ManyToOne(() => Terminal)
  terminal!: Rel<Terminal>;

  @Enum({ items: () => Carrier })
  carrier!: Carrier;

  @Property({ unique: true, length: 30 })
  trackingNo!: string;

  @Enum({ items: () => ShipmentStatus })
  status: ShipmentStatus = ShipmentStatus.IN_TRANSIT;

  /** 마지막으로 택배사 조회에 성공한 시각 */
  @Property({ type: 'datetime', nullable: true })
  lastSyncedAt?: Date | null;

  /** 택배사가 알려 준 배송 완료 시각 */
  @Property({ type: 'datetime', nullable: true })
  deliveredAt?: Date | null;

  @Property()
  createdAt: Date = new Date();
}

/** 택배사에서 받은 배송 이벤트. (운송장, eventKey)가 같으면 같은 이벤트라서 한 번만 저장한다. */
@Entity({ tableName: 'carrier_event' })
@Unique({ properties: ['shipment', 'eventKey'] })
export class CarrierEvent {
  [OptionalProps]?: 'receivedAt';

  @PrimaryKey()
  id!: number;

  // FK 열 단독 인덱스를 만들지 않는다: unique(shipment_id, event_key)이 이 열로 시작해 FK 검사·조회를 대신한다(decisions/0032)
  @ManyToOne(() => Shipment, { index: false })
  shipment!: Rel<Shipment>;

  @Property({ length: 50 })
  eventKey!: string;

  @Enum({ items: () => CarrierEventCode })
  code!: CarrierEventCode;

  @Property()
  occurredAt!: Date;

  /** 택배사 원본 */
  @Property({ type: 'json' })
  raw!: Record<string, unknown>;

  @Property()
  receivedAt: Date = new Date();
}

/** 택배 수집 실행 한 번의 결과(SyncRun.outcome). 컬럼은 varchar라 값 목록은 여기 한 곳에 둔다 */
export const SYNC_RUN_OUTCOMES = ['OK', 'DELIVERED', 'NOOP', 'SKIPPED', 'ERROR'] as const;
export type SyncRunOutcome = (typeof SYNC_RUN_OUTCOMES)[number];

/** 수집 job 실행 1회의 기록. 실험에서 호출·중복·재시도 수를 셀 때 쓴다. */
@Entity({ tableName: 'sync_run' })
export class SyncRun {
  [OptionalProps]?: 'startedAt' | 'fetched' | 'inserted' | 'duplicated';

  @PrimaryKey()
  id!: number;

  /** 큐 이름(track-bungae 등) */
  @Property({ length: 50 })
  job!: string;

  @ManyToOne(() => Shipment, { nullable: true })
  shipment?: Rel<Shipment> | null;

  /** 몇 번째 시도인지(1부터) */
  @Property()
  attempt!: number;

  /** 처리한 프로세스(WORKER_NAME 또는 pid-<pid>) */
  @Property({ length: 50 })
  worker!: string;

  /** SYNC_RUN_OUTCOMES 중 하나 */
  @Property({ length: 20 })
  outcome!: SyncRunOutcome;

  @Property()
  startedAt: Date = new Date();

  @Property({ type: 'datetime', nullable: true })
  finishedAt?: Date | null;

  /** 택배사가 준 이벤트 수(중복 포함) */
  @Property()
  fetched: number = 0;

  /** 새로 저장한 이벤트 수 */
  @Property()
  inserted: number = 0;

  /** 이미 있어서 건너뛴 이벤트 수(응답 안 중복 + 이미 저장된 것) */
  @Property()
  duplicated: number = 0;

  /** 오류 메시지, 또는 NOOP·SKIPPED인 이유 */
  @Property({ length: 500, nullable: true })
  detail?: string | null;
}
