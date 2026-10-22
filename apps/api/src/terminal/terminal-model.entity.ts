import { OptionalProps } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'terminal_model' })
export class TerminalModel {
  [OptionalProps]?: 'requiresReinspection';

  @PrimaryKey()
  id!: number;

  @Property({ unique: true, length: 20 })
  code!: string;

  @Property({ length: 50 })
  name!: string;

  /** 회수된 단말기를 재검수 없이 재고로 돌릴 수 없는 모델인지 */
  @Property()
  requiresReinspection: boolean = false;
}
