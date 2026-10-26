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

  // FK 열 단독 인덱스를 만들지 않는다: unique(model_id, code)이 이 열로 시작해 FK 검사·조회를 대신한다(decisions/0032)
  @ManyToOne(() => TerminalModel, { index: false })
  model!: Rel<TerminalModel>;

  @Property({ length: 30 })
  code!: string;

  @Property({ length: 50 })
  label!: string;

  @Property()
  sortOrder: number = 0;
}
