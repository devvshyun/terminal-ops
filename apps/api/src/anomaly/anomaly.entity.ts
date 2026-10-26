import { OptionalProps } from '@mikro-orm/core';
import { Entity, Enum, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

/** 이상 단말기 규칙(F4). 기준일은 env(ANOMALY_*_DAYS)로 바꾼다 */
export enum AnomalyRule {
  /** 배송 완료(DELIVERED)가 된 지 N일(기본 7) 넘게 설치(IN_SERVICE)되지 않음 */
  DELIVERED_NOT_INSTALLED = 'DELIVERED_NOT_INSTALLED',
  /** 회수 요청·회수 중(RETURN_REQUESTED·RETURNING)이 N일(기본 14) 넘음 */
  RETURN_STALLED = 'RETURN_STALLED',
  /** 출고(SHIPPED)가 N일(기본 10) 넘음 — 배송 완료가 반영되지 않음 */
  SHIPPED_TOO_LONG = 'SHIPPED_TOO_LONG',
  /** 배정(ALLOCATED)이 N일(기본 3) 넘었는데 출고 없음 */
  ALLOCATED_NO_SHIPMENT = 'ALLOCATED_NO_SHIPMENT',
  /** 운영 중인데 가맹점 없음 */
  IN_SERVICE_NO_MERCHANT = 'IN_SERVICE_NO_MERCHANT',
  /** 운영 중인데 마지막 하트비트가 N일(기본 3) 넘게 전(online 값과 상관없이), 하트비트가 한 번도 없으면 운영 시작이 N일 넘게 전 */
  OFFLINE_TOO_LONG = 'OFFLINE_TOO_LONG',
}

/**
 * 이상 단말기 한 건(F4). 규칙에 걸린 동안 열려 있고(resolved_at null), 조건이 풀리면 닫힌다.
 * 열린 이상은 (단말기, 규칙)마다 하나 — MySQL에는 부분 unique가 없어 MikroORM이
 * `unique((case when resolved_at is null then terminal_id end), (case when resolved_at is null then rule end))` 함수 인덱스로 흉내 낸다
 * (닫힌 행은 두 값이 NULL이라 서로 겹쳐도 된다, decisions/0034). 같은 단말기가 다시 걸리면 새 행이 생긴다(이력).
 * terminal_id에 외래키를 두지 않는다 — 찾기 job이 수천 행을 한 번에 넣을 때 단말기 행마다 FK 검사 S 락을 걸지 않게(device_connectivity와 같은 이유).
 */
@Entity({ tableName: 'anomaly' })
@Unique({ name: 'anomaly_open_unique', properties: ['terminalId', 'rule'], where: { resolvedAt: null } })
@Index({ properties: ['resolvedAt', 'rule'] })
export class Anomaly {
  [OptionalProps]?: 'resolvedAt';

  @PrimaryKey()
  id!: number;

  /** terminal.id */
  @Property({ unsigned: true })
  terminalId!: number;

  @Enum({ items: () => AnomalyRule })
  rule!: AnomalyRule;

  /** 처음 걸린 찾기 시각 */
  @Property({ type: 'datetime', length: 3 })
  detectedAt!: Date;

  /** 마지막으로 걸린 찾기 시각(계속 걸려 있으면 매 실행 갱신) */
  @Property({ type: 'datetime', length: 3 })
  lastSeenAt!: Date;

  /** 조건이 풀린 찾기 시각. null이면 열린 이상 */
  @Property({ type: 'datetime', length: 3, nullable: true })
  resolvedAt: Date | null = null;

  /** 걸렸을 때의 값(상태, 그 상태가 된 시각, 마지막 하트비트 등) */
  @Property({ type: 'json' })
  detail!: Record<string, unknown>;
}
