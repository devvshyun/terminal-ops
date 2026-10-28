import type { EntityManager } from '@mikro-orm/mysql';
import type { PartnerScope } from '@terminal-ops/contracts';
import { PartnerApiKey } from '../auth/partner-key.entity.js';
import { sha256Hex } from '../auth/partner-key.service.js';
import { hashPassword } from '../auth/password.js';
import { Role } from '../auth/role.js';
import { UserAccount } from '../auth/user-account.entity.js';
import { Merchant } from '../merchant/merchant.entity.js';

/**
 * 로컬 시연 전용 계정(보강 2). 비밀번호는 이 저장소에 공개된 **테스트 값**이다 — 실제 서비스에 쓰지 않는다(README "로컬 시연 전용 값").
 * 역할마다 하나, 가맹점주는 시드 가맹점(seed-reference.ts MERCHANT_SEEDS) 세 곳에 하나씩.
 * 테스트(resetDatabase)는 이 계정을 넣지 않는다 — 해시 7번(약 1초)을 파일마다 쓰지 않게, 필요한 테스트가 직접 만든다.
 */
export const DEMO_ACCOUNTS: { loginId: string; displayName: string; role: Role; password: string; merchantCode?: string }[] = [
  { loginId: 'admin', displayName: '관리자(시연)', role: Role.ADMIN, password: 'demo-admin-i85thLR_' },
  { loginId: 'operator', displayName: '운영자(시연)', role: Role.OPERATOR, password: 'demo-operator-KG0TjBaF' },
  { loginId: 'monitor', displayName: '관제(시연)', role: Role.MONITOR, password: 'demo-monitor-s0HXGiA0' },
  { loginId: 'field', displayName: '현장 작업자(시연)', role: Role.FIELD, password: 'demo-field-uWNme8sf' },
  { loginId: 'merchant-gangnam', displayName: '강남김밥 점주(시연)', role: Role.MERCHANT, password: 'demo-merchant-PhEqKald', merchantCode: 'GANGNAM-KIMBAP' },
  { loginId: 'merchant-yeoksam', displayName: '역삼카페 점주(시연)', role: Role.MERCHANT, password: 'demo-merchant-PhEqKald', merchantCode: 'YEOKSAM-CAFE' },
  { loginId: 'merchant-pangyo', displayName: '판교분식 점주(시연)', role: Role.MERCHANT, password: 'demo-merchant-PhEqKald', merchantCode: 'PANGYO-BUNSIK' },
];

/**
 * 외부 업체 시연 키(decisions/0054). 원문을 시드에 고정한 **테스트 값**이다 — 시연 때 README의 curl을 그대로 쓰게.
 * 실제 발급(POST /admin/partner-keys)은 원문을 그 응답에서 한 번만 보여 주고 저장하지 않는다.
 */
export const DEMO_PARTNER_KEY = {
  name: '데모 연동 업체(시연)',
  key: 'pk_demo0001_iT6FP93uZalQ_kHGfNaufkHW8XgpwiJQcEbq1k0SW4g',
  scopes: ['terminal-status:read', 'merchant-terminals:read'] as PartnerScope[],
};

/** 시연 외부 업체 키를 넣는다. 같은 접두사가 있으면 건너뛴다. 넣었으면 true */
export async function seedDemoPartnerKey(em: EntityManager): Promise<boolean> {
  if (await em.findOne(PartnerApiKey, { prefix: DEMO_PARTNER_KEY.key.slice(0, 11) })) return false;
  em.create(PartnerApiKey, {
    name: DEMO_PARTNER_KEY.name,
    prefix: DEMO_PARTNER_KEY.key.slice(0, 11),
    keyHash: sha256Hex(DEMO_PARTNER_KEY.key),
    scopes: DEMO_PARTNER_KEY.scopes,
    createdBy: 'system:seed',
  });
  await em.flush();
  return true;
}

/** 시연 계정을 넣는다. 이미 있는 아이디는 건너뛴다(비밀번호·역할을 되돌리지 않는다 — 시연 중 바꾼 값을 지우지 않게). 넣은 수를 돌려준다 */
export async function seedDemoAccounts(em: EntityManager): Promise<number> {
  let created = 0;
  for (const seed of DEMO_ACCOUNTS) {
    if (await em.findOne(UserAccount, { loginId: seed.loginId })) continue;
    const merchant = seed.merchantCode ? await em.findOneOrFail(Merchant, { code: seed.merchantCode }) : null;
    em.create(UserAccount, {
      loginId: seed.loginId,
      displayName: seed.displayName,
      role: seed.role,
      merchant,
      passwordHash: await hashPassword(seed.password),
    });
    created += 1;
  }
  await em.flush();
  return created;
}
