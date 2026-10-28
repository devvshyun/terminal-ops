import { OptionalProps } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import type { PartnerScope } from '@terminal-ops/contracts';

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

  /** 업체 이름(표시용) */
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
