import { OptionalProps } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/** 업체 코드: 대문자·숫자·`-` 2~20자 */
export const PARTNER_CODE = /^[A-Z0-9-]{2,20}$/;

/**
 * 외부 업체(보강 7, decisions/0081). 우리 API를 부르는 쪽이다 — 우리가 부르는 가상 업체(apps/partners: 세움·번개·느림보·브릿지VAN·톡톡)와 다르다.
 * 키(partner_api_key)는 업체 하나에 속한다. 지우는 API는 없다(키를 폐기한다).
 */
@Entity({ tableName: 'partner' })
export class Partner {
  [OptionalProps]?: 'memo' | 'createdAt';

  @PrimaryKey()
  id!: number;

  @Property({ unique: true, length: 20 })
  code!: string;

  @Property({ length: 50 })
  name!: string;

  @Property({ type: 'varchar', length: 200, nullable: true })
  memo: string | null = null;

  @Property({ length: 50 })
  createdBy!: string;

  @Property()
  createdAt: Date = new Date();
}
