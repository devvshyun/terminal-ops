import { OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, Enum, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { Terminal } from './terminal.entity.js';
import { TerminalStatus, TransitionSource } from './terminal-status.js';

/** 상태 변경 이력. 추가만 하고 수정·삭제하지 않는다. */
@Entity({ tableName: 'terminal_status_history' })
@Index({ properties: ['terminal', 'occurredAt'] })
export class TerminalStatusHistory {
  [OptionalProps]?: 'occurredAt';

  @PrimaryKey()
  id!: number;

  // FK 열 단독 인덱스를 만들지 않는다: (terminal_id, occurred_at) 인덱스이 이 열로 시작해 FK 검사·조회를 대신한다(decisions/0032)
  @ManyToOne(() => Terminal, { index: false })
  terminal!: Rel<Terminal>;

  /** 등록 이력은 이전 상태가 없어 null */
  @Enum({ items: () => TerminalStatus, nullable: true })
  fromStatus?: TerminalStatus | null;

  @Enum({ items: () => TerminalStatus })
  toStatus!: TerminalStatus;

  @Enum({ items: () => TransitionSource })
  source!: TransitionSource;

  @Property({ length: 50 })
  actor!: string;

  @Property({ length: 200 })
  reason!: string;

  @Property()
  occurredAt: Date = new Date();
}
