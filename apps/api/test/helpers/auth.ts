import { expect } from 'vitest';
import { hashPassword } from '../../src/auth/password.js';
import type { Role } from '../../src/auth/role.js';
import { UserAccount } from '../../src/auth/user-account.entity.js';
import { Merchant } from '../../src/merchant/merchant.entity.js';
import type { TestApp } from './test-app.js';

/** 테스트 계정의 비밀번호(테스트 DB 전용 값) */
export const TEST_PASSWORD = 'test-password-1234';

/** 계정 행을 바로 만든다(ADMIN API를 거치지 않는 준비용). merchantCode는 MERCHANT일 때 */
export async function createAccount(t: TestApp, loginId: string, role: Role | `${Role}`, merchantCode?: string): Promise<UserAccount> {
  const em = t.orm.em.fork();
  const merchant = merchantCode ? await em.findOneOrFail(Merchant, { code: merchantCode }) : null;
  const account = em.create(UserAccount, {
    loginId,
    displayName: `${loginId} 이름`,
    role: role as Role,
    merchant,
    passwordHash: await hashPassword(TEST_PASSWORD),
  });
  await em.flush();
  return account;
}

/** 실제 로그인(POST /auth/login)으로 세션 쿠키(`sid=…`)를 받는다 */
export async function login(t: TestApp, loginId: string, password = TEST_PASSWORD): Promise<string> {
  const res = await t.http(null).post('/auth/login').send({ loginId, password });
  expect(res.status).toBe(200);
  const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('sid='));
  expect(cookie).toBeDefined();
  return cookie!.split(';')[0];
}

/** 세션 쿠키만 붙인 요청(테스트 헤더 없음) */
export function withCookie(t: TestApp, cookie: string) {
  return t.http(null).set('Cookie', cookie);
}
