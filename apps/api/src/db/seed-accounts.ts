import type { EntityManager } from '@mikro-orm/mysql';
import type { PartnerScope } from '@terminal-ops/contracts';
import { PartnerApiKey } from '../auth/partner-key.entity.js';
import { Partner } from '../partner/partner.entity.js';
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
 * 시연 계정·시연 외부 업체 키를 넣어도 되나(Task 5 보안 리뷰, decisions/0054). 둘 다 저장소에 공개된 고정 값이라
 * NODE_ENV=production이면 넣지 않는다(켜는 플래그도 두지 않는다 — 운영 DB에 공개 비밀번호가 들어갈 길을 남기지 않는다).
 * 개발에서도 SEED_DEMO=0이면 기준 데이터만 넣는다.
 */
export function demoSeedAllowed(e: Record<string, string | undefined> = process.env): boolean {
  if (e.NODE_ENV === 'production') return false;
  return e.SEED_DEMO !== '0';
}

/**
 * 외부 업체 시연 키(decisions/0054). 원문을 시드에 고정한 **테스트 값**이다 — 시연 때 README의 curl을 그대로 쓰게.
 * 실제 발급(POST /admin/partner-keys)은 원문을 그 응답에서 한 번만 보여 주고 저장하지 않는다.
 */
/** 시연 키가 속한 업체(보강 7, decisions/0081) */
export const DEMO_PARTNER = { code: 'DEMO', name: '데모 연동 업체(시연)' };

export const DEMO_PARTNER_KEY = {
  name: '시연 키',
  key: 'pk_demo0001_iT6FP93uZalQ_kHGfNaufkHW8XgpwiJQcEbq1k0SW4g',
  scopes: ['terminal-status:read', 'merchant-terminals:read'] as PartnerScope[],
};

/**
 * 시연 외부 업체와 그 키를 넣는다. 같은 접두사의 키가 있으면 건너뛴다(업체도 만들지 않는다). 넣었으면 true.
 * 보강 7 전에 시드한 DB는 마이그레이션이 키 이름으로 업체를 만들어(코드 `P-<id>`) 시연 키가 이미 있으므로 DEMO 업체가 생기지 않는다.
 */
export async function seedDemoPartnerKey(em: EntityManager): Promise<boolean> {
  if (await em.findOne(PartnerApiKey, { prefix: DEMO_PARTNER_KEY.key.slice(0, 11) })) return false;
  const partner = (await em.findOne(Partner, { code: DEMO_PARTNER.code })) ?? em.create(Partner, { ...DEMO_PARTNER, createdBy: 'system:seed' });
  em.create(PartnerApiKey, {
    partner,
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
