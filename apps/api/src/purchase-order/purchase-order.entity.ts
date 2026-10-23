import { OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, Enum, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TerminalModel } from '../terminal/terminal-model.entity.js';

export enum PurchaseOrderStatus {
  ORDERED = 'ORDERED', // 공장에 발주함
  RECEIVING = 'RECEIVING', // 입고 스캔을 시작함
  CLOSED = 'CLOSED', // 마감. 더는 입고 스캔을 받지 않는다
}

/** 세움전자(가상 공장)에 낸 발주. 발주번호(poNo)는 공장이 정한다. */
@Entity({ tableName: 'purchase_order' })
export class PurchaseOrder {
  [OptionalProps]?: 'status' | 'deliveryNote' | 'createdAt' | 'closedAt' | 'closedBy';

  @PrimaryKey()
  id!: number;

  @Property({ unique: true, length: 30 })
  poNo!: string;

  @ManyToOne(() => TerminalModel)
  model!: Rel<TerminalModel>;

  @Property()
  quantity!: number;

  @Enum({ items: () => PurchaseOrderStatus })
  status: PurchaseOrderStatus = PurchaseOrderStatus.ORDERED;

  /** 공장이 보낸 납품 명세(시리얼 목록). 입고를 시작할 때 받아 와 저장한다. 아직 안 받았으면 null */
  @Property({ type: 'json', nullable: true })
  deliveryNote: string[] | null = null;

  @Property({ length: 50 })
  orderedBy!: string;

  @Property()
  createdAt: Date = new Date();

  // 유니온 타입(Date | null)은 데코레이터 메타데이터가 Object라 type을 꼭 적는다.
  @Property({ type: 'datetime', nullable: true })
  closedAt: Date | null = null;

  @Property({ type: 'varchar', length: 50, nullable: true })
  closedBy: string | null = null;
}
