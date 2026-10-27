import { OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, Enum, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { Merchant } from '../merchant/merchant.entity.js';
import { Role } from './role.js';

/**
 * 사람 계정(보강 2, decisions/0051). 로그인 아이디가 이력·검수·스캔의 actor가 된다(decisions/0056).
 * MERCHANT만 merchant가 있다 — 서비스(AccountService)가 지킨다(DB 제약은 두지 않음, decisions/0051).
 */
@Entity({ tableName: 'user_account' })
export class UserAccount {
  [OptionalProps]?: 'merchant' | 'disabledAt' | 'lastLoginAt' | 'createdAt' | 'updatedAt';

  @PrimaryKey()
  id!: number;

  /** 로그인 아이디(영문 소문자·숫자·`.`·`-`·`_` 3~50자). 이력 actor로 남으므로 바꾸지 않는다 */
  @Property({ unique: true, length: 50 })
  loginId!: string;

  @Property({ length: 50 })
  displayName!: string;

  /** `scrypt$N$r$p$salt$hash`(password.ts) */
  @Property({ length: 200 })
  passwordHash!: string;

  @Enum({ items: () => Role })
  role!: Role;

  @ManyToOne(() => Merchant, { nullable: true })
  merchant: Rel<Merchant> | null = null;

  /** 값이 있으면 로그인할 수 없다 */
  @Property({ type: 'datetime', nullable: true })
  disabledAt: Date | null = null;

  @Property({ type: 'datetime', nullable: true })
  lastLoginAt: Date | null = null;

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
