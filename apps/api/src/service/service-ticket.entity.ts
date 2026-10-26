import { OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, Enum, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { Merchant } from '../merchant/merchant.entity.js';
import { Shipment } from '../shipment/shipment.entities.js';
import { Terminal } from '../terminal/terminal.entity.js';

export enum ServiceTicketStatus {
  OPEN = 'OPEN', // 접수됨(원격 점검 전·후)
  RESOLVED_REMOTELY = 'RESOLVED_REMOTELY', // 원격으로 해결, 종결
  REPLACING = 'REPLACING', // 교체 단말기 출고됨, 설치 확인 대기
  CLOSED = 'CLOSED', // 교체 설치 확인, 종결
}

/** 열려 있는(아직 종결되지 않은) 상태 */
export const OPEN_TICKET_STATUSES = [ServiceTicketStatus.OPEN, ServiceTicketStatus.REPLACING];

/** A/S 접수 한 건(F7). 원격 점검으로 끝나거나, 교체 출고 → 설치 확인으로 끝난다. */
@Entity({ tableName: 'service_ticket' })
@Index({ properties: ['terminal', 'status'] })
export class ServiceTicket {
  [OptionalProps]?: 'status' | 'remoteNote' | 'replacementTerminal' | 'outboundShipment' | 'createdAt' | 'closedAt';

  @PrimaryKey()
  id!: number;

  /** 고장 접수된 단말기 */
  // FK 열 단독 인덱스를 만들지 않는다: (terminal_id, status) 인덱스이 이 열로 시작해 FK 검사·조회를 대신한다(decisions/0032)
  @ManyToOne(() => Terminal, { index: false })
  terminal!: Rel<Terminal>;

  @ManyToOne(() => Merchant)
  merchant!: Rel<Merchant>;

  @Property({ length: 200 })
  symptom!: string;

  @Enum({ items: () => ServiceTicketStatus })
  status: ServiceTicketStatus = ServiceTicketStatus.OPEN;

  @Property({ type: 'varchar', length: 500, nullable: true })
  remoteNote: string | null = null;

  /** 교체로 보낸 단말기 */
  @ManyToOne(() => Terminal, { nullable: true })
  replacementTerminal: Rel<Terminal> | null = null;

  /** 교체 단말기 운송장 */
  @ManyToOne(() => Shipment, { nullable: true })
  outboundShipment: Rel<Shipment> | null = null;

  @Property({ length: 50 })
  openedBy!: string;

  @Property()
  createdAt: Date = new Date();

  @Property({ type: 'datetime', nullable: true })
  closedAt: Date | null = null;
}
