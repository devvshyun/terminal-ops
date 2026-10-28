import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

  it('판단은 잠근 행(지금 커밋된 값)으로 — 처음 읽은 뒤 대상이 이미 활성 ADMIN이 아니게 됐으면, 활성 ADMIN이 0이어도 409를 내지 않는다', async () => {
    // 트랜잭션의 일반 읽기(REPEATABLE READ 스냅샷)는 처음 읽은 값을 계속 보고, FOR UPDATE 잠금 읽기만 지금 값을 본다.
    // 대상 행을 처음 읽은 바로 뒤에 다른 연결이 ADMIN을 모두 사용 중지한다(SQL로 고친 상황) — 잠근 목록은 비고 스냅샷은 "활성 ADMIN"이다
    const target = await createAccount(t, 'stale-admin', 'ADMIN');
    const cookie = await login(t, target.loginId);
    const proto = Object.getPrototypeOf(t.orm.em) as { findOne: (...args: unknown[]) => Promise<unknown> };
    const original = proto.findOne;
    let injected = false;
    const spy = vi.spyOn(proto, 'findOne').mockImplementation(async function (this: unknown, ...args: unknown[]) {
      const result = await original.apply(this, args);
      if (!injected && args[0] === UserAccount && args[1] === target.id) {
        injected = true;
        await t.orm.em.fork().nativeUpdate(UserAccount, { role: Role.ADMIN }, { disabledAt: new Date() });
      }
      return result;
    });
    try {
      const res = await withCookie(t, cookie).patch(`/admin/accounts/${target.id}`).send({ role: 'OPERATOR' });
      expect(injected).toBe(true);
      expect([res.status, res.body.code]).toEqual([200, undefined]);
      expect(res.body.role).toBe('OPERATOR');
    } finally {
      spy.mockRestore();
    }
  });
});
