import { OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, Enum, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { Merchant } from '../merchant/merchant.entity.js';
import { PurchaseOrder } from '../purchase-order/purchase-order.entity.js';
import { TerminalModel } from './terminal-model.entity.js';
import { TerminalStatus } from './terminal-status.js';

/**
 * (status, status_changed_at) 복합 인덱스: "어떤 상태로 N일 넘게 있는 단말기"(이상 단말기 찾기, F4)를 범위 하나로 찾는다.
 * status 하나만으로 찾는 쿼리(운영 중 단말기 목록 등)도 이 인덱스의 앞부분을 쓴다 — 그래서 status 단독 인덱스는 없앴다(decisions/0034).
 */
@Entity({ tableName: 'terminal' })
@Index({ properties: ['status', 'statusChangedAt'] })
export class Terminal {
  [OptionalProps]?: 'status' | 'statusChangedAt' | 'version' | 'createdAt' | 'updatedAt';

  @PrimaryKey()
  id!: number;

  @Property({ unique: true, length: 32 })
  serialNo!: string;

  // Rel<>: ESM 순환 import에서 데코레이터 메타데이터가 클래스를 너무 일찍 참조하지 않게 한다.
  @ManyToOne(() => TerminalModel)
  model!: Rel<TerminalModel>;

  /** 배정된 가맹점. 배정 전에는 null */
  @ManyToOne(() => Merchant, { nullable: true })
  merchant?: Rel<Merchant> | null;

  /** 박스 스캔으로 입고된 발주. 단건·엑셀 등록이면 null (F10 대조에 쓴다) */
  @ManyToOne(() => PurchaseOrder, { nullable: true })
  purchaseOrder?: Rel<PurchaseOrder> | null;

  @Enum({ items: () => TerminalStatus })
  status: TerminalStatus = TerminalStatus.RECEIVED;

  /**
   * 지금 상태가 된 시각. 전이 서비스가 상태와 같은 UPDATE에서 바꾸고, 같은 값을 이력 occurred_at에 쓴다(decisions/0034).
   * updatedAt은 가맹점·version 등 다른 변경에도 바뀌어 "그 상태가 된 시각"으로 쓸 수 없다.
   */
  @Property({ type: 'datetime', length: 3 })
  statusChangedAt: Date = new Date();

  /** 낙관적 락. flush할 때 WHERE version = ? 로 확인하고 1 올린다. */
  @Property({ version: true })
  version!: number;

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
