import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyPassword } from '../src/auth/password.js';
import { UserAccount } from '../src/auth/user-account.entity.js';
import { DEMO_ACCOUNTS, seedDemoAccounts } from '../src/db/seed-accounts.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('시연 계정 시드 (보강 2, decisions/0051)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('테스트 DB 기준 데이터에는 계정이 없다(필요한 테스트가 직접 만든다)', async () => {
    expect(await t.orm.em.fork().count(UserAccount)).toBe(0);
  });

  it('역할마다 하나, 가맹점주는 가맹점마다 하나 — 7개. 두 번 돌려도 늘지 않는다', async () => {
    expect(await seedDemoAccounts(t.orm.em.fork())).toBe(7);
    expect(await seedDemoAccounts(t.orm.em.fork())).toBe(0);
    const rows = await t.orm.em.fork().find(UserAccount, {}, { populate: ['merchant'], orderBy: { id: 'asc' } });
    expect(rows.map((a) => [a.loginId, a.role, a.merchant?.code ?? null])).toEqual([
      ['admin', 'ADMIN', null],
      ['operator', 'OPERATOR', null],
      ['monitor', 'MONITOR', null],
      ['field', 'FIELD', null],
      ['merchant-gangnam', 'MERCHANT', 'GANGNAM-KIMBAP'],
      ['merchant-yeoksam', 'MERCHANT', 'YEOKSAM-CAFE'],
      ['merchant-pangyo', 'MERCHANT', 'PANGYO-BUNSIK'],
    ]);
  });

  it('저장된 것은 해시이고 시드 비밀번호로 확인된다', async () => {
    const operator = await t.orm.em.fork().findOneOrFail(UserAccount, { loginId: 'operator' });
    const seed = DEMO_ACCOUNTS.find((a) => a.loginId === 'operator')!;
    expect(operator.passwordHash).not.toContain(seed.password);
    expect(await verifyPassword(seed.password, operator.passwordHash)).toBe(true);
  });
});
