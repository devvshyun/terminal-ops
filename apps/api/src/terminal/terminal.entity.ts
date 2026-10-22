import { OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, Enum, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TerminalModel } from './terminal-model.entity.js';
import { TerminalStatus } from './terminal-status.js';

@Entity({ tableName: 'terminal' })
@Index({ properties: ['status'] })
export class Terminal {
  [OptionalProps]?: 'status' | 'version' | 'createdAt' | 'updatedAt';

  @PrimaryKey()
  id!: number;

  @Property({ unique: true, length: 32 })
  serialNo!: string;

  // Rel<>: ESM 순환 import에서 데코레이터 메타데이터가 클래스를 너무 일찍 참조하지 않게 한다.
  @ManyToOne(() => TerminalModel)
  model!: Rel<TerminalModel>;

  @Enum({ items: () => TerminalStatus })
  status: TerminalStatus = TerminalStatus.RECEIVED;

  /** 낙관적 락. flush할 때 WHERE version = ? 로 확인하고 1 올린다. */
  @Property({ version: true })
  version!: number;

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
