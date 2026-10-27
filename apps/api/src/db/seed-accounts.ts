import type { EntityManager } from '@mikro-orm/mysql';
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
