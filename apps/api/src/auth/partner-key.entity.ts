import { OptionalProps } from '@mikro-orm/core';
import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import type { PartnerScope } from '@terminal-ops/contracts';
import { Partner } from '../partner/partner.entity.js';

/** 외부 업체 키가 할 수 있는 일(contracts PartnerScope와 같다 — contract-assertions.ts) */
export const PARTNER_SCOPES = ['terminal-status:read', 'merchant-terminals:read'] as const;

/**
 * 외부 업체 API 키(보강 2, decisions/0054). 원문은 저장하지 않는다 — SHA-256만(키가 32바이트 무작위라 느린 해시가 필요 없다).
 * 키 모양 `pk_<접두사 8자>_<비밀 43자>`. prefix(`pk_xxxxxxxx`)는 평문으로 두어 찾기·화면 표시에 쓴다.
 */
@Entity({ tableName: 'partner_api_key' })
export class PartnerApiKey {
  [OptionalProps]?: 'expiresAt' | 'revokedAt' | 'lastUsedAt' | 'createdAt';

  @PrimaryKey()
  id!: number;

  /** 어느 업체의 키인가(보강 7, decisions/0081) */
  @ManyToOne(() => Partner)
  partner!: Partner;

  /** 키 이름표(어디에 쓰는 키인지). 보강 7 전에는 업체 이름을 적던 칸 — 마이그레이션이 그 이름으로 업체를 만들었다 */
  @Property({ length: 50 })
  name!: string;

  @Property({ unique: true, length: 16 })
  prefix!: string;

  /** 키 원문의 SHA-256(hex) */
  @Property({ length: 64 })
  keyHash!: string;

  @Property({ type: 'json' })
  scopes!: PartnerScope[];

  @Property({ type: 'datetime', nullable: true })
  expiresAt: Date | null = null;

  @Property({ type: 'datetime', nullable: true })
  revokedAt: Date | null = null;

  /** 마지막으로 쓴 시각. 1분에 한 번만 갱신한다(요청마다 UPDATE하지 않게) */
  @Property({ type: 'datetime', nullable: true })
  lastUsedAt: Date | null = null;

  @Property({ length: 50 })
  createdBy!: string;

  @Property()
  createdAt: Date = new Date();
}
