import { Collection, OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, ManyToOne, OneToMany, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { Terminal } from '../terminal/terminal.entity.js';

// Inspection ↔ InspectionResult는 서로 참조한다. ESM에서 파일을 나누면 순환 import가 생기므로 한 파일에 두고,
// 참조되는 쪽(Inspection)을 먼저 선언한다.

/** 검수 1회. 결과 항목과 함께 저장되고, 저장과 같은 트랜잭션에서 단말기 상태가 바뀐다. */
@Entity({ tableName: 'inspection' })
export class Inspection {
  [OptionalProps]?: 'inspectedAt';

  @PrimaryKey()
  id!: number;

  @ManyToOne(() => Terminal)
  terminal!: Rel<Terminal>;

  @Property()
  passed!: boolean;

  @Property({ length: 50 })
  actor!: string;

  @Property()
  inspectedAt: Date = new Date();

  @OneToMany(() => InspectionResult, (r) => r.inspection)
  results = new Collection<InspectionResult>(this);
}

@Entity({ tableName: 'inspection_result' })
export class InspectionResult {
  @PrimaryKey()
  id!: number;

  @ManyToOne(() => Inspection)
  inspection!: Rel<Inspection>;

  @Property({ length: 30 })
  itemCode!: string;

  @Property()
  passed!: boolean;

  @Property({ length: 200, nullable: true })
  note?: string | null;
}
