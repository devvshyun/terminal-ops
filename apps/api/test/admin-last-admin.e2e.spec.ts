import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Role } from '../src/auth/role.js';
import { UserAccount } from '../src/auth/user-account.entity.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { createAccount, login, withCookie } from './helpers/auth.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('마지막 활성 ADMIN 보호 — 동시 요청 (decisions/0054)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
  });
  afterAll(async () => {
    await deleteTestKeys(t.app.get<Redis>(REDIS));
    await t.app.close();
  });

  const activeAdmins = () => t.orm.em.fork().count(UserAccount, { role: Role.ADMIN, disabledAt: null });

  it.each([
    ['사용 중지', { disabled: true }],
    ['강등', { role: 'OPERATOR' }],
  ])('ADMIN 둘이 서로를 동시에 %s하면 하나만 성공하고 하나는 409 LAST_ADMIN — 활성 ADMIN이 0이 되지 않는다', async (_label, patch) => {
    const a = await createAccount(t, `race-a-${Object.keys(patch)[0]}`, 'ADMIN');
    const b = await createAccount(t, `race-b-${Object.keys(patch)[0]}`, 'ADMIN');
    // 다른 테스트가 만든 ADMIN이 섞이지 않게 이 둘만 ADMIN으로 둔다
    await t.orm.em.fork().nativeUpdate(UserAccount, { id: { $nin: [a.id, b.id] }, role: Role.ADMIN }, { disabledAt: new Date() });
    // 여러 번 겹쳐 본다(한 번만으로는 순서가 우연히 맞을 수 있다)
    for (let round = 0; round < 5; round += 1) {
      const ca = await login(t, a.loginId);
      const cb = await login(t, b.loginId);
      const [r1, r2] = await Promise.all([
        withCookie(t, ca).patch(`/admin/accounts/${b.id}`).send(patch),
        withCookie(t, cb).patch(`/admin/accounts/${a.id}`).send(patch),
      ]);
      expect([r1.status, r2.status].sort(), `round ${round}`).toEqual([200, 409]);
      expect((r1.status === 409 ? r1 : r2).body.code).toBe('LAST_ADMIN');
      expect(await activeAdmins(), `round ${round}`).toBe(1);
      // 다음 라운드를 위해 둘 다 ADMIN·활성으로 되돌린다(행을 직접 고침)
      await t.orm.em.fork().nativeUpdate(UserAccount, { id: { $in: [a.id, b.id] } }, { role: Role.ADMIN, disabledAt: null });
    }
  });
});
