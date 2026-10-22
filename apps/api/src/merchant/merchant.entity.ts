import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/** 가맹점(가상). 단말기를 배정받는 곳 */
@Entity({ tableName: 'merchant' })
export class Merchant {
  @PrimaryKey()
  id!: number;

  @Property({ unique: true, length: 20 })
  code!: string;

  @Property({ length: 50 })
  name!: string;

  @Property({ length: 200 })
  address!: string;
}
