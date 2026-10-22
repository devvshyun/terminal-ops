import { OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';
import { TerminalModel } from '../terminal/terminal-model.entity.js';

/** 모델별 검수 체크리스트 항목 */
@Entity({ tableName: 'inspection_item' })
@Unique({ properties: ['model', 'code'] })
export class InspectionItem {
  [OptionalProps]?: 'sortOrder';

  @PrimaryKey()
  id!: number;

  @ManyToOne(() => TerminalModel)
  model!: Rel<TerminalModel>;

  @Property({ length: 30 })
  code!: string;

  @Property({ length: 50 })
  label!: string;

  @Property()
  sortOrder: number = 0;
}
