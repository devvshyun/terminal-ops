import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { dummyPasswordHash } from '../src/auth/password.js';
import { Role } from '../src/auth/role.js';
import { SessionStore } from '../src/auth/session.store.js';
import { UserAccount } from '../src/auth/user-account.entity.js';
import { env } from '../src/config/env.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { createAccount, login, TEST_PASSWORD, withCookie } from './helpers/auth.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('로그인·세션·역할 (보강 2, decisions/0050·0052·0056)', () => {
  let t: TestApp;
  let redis: Redis;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    redis = t.app.get(REDIS);
    await deleteTestKeys(redis);
    await createAccount(t, 'op1', 'OPERATOR');
    await createAccount(t, 'mon1', 'MONITOR');
    await createAccount(t, 'field1', 'FIELD');
    await createAccount(t, 'admin1', 'ADMIN');
  });
  afterAll(async () => {
    await deleteTestKeys(redis);
    await t.app.close();
  });

  it('가짜 해시는 앱이 뜰 때 미리 만든다 — 첫 "없는 아이디" 로그인만 두 배 느려지지 않게(Task 1 리뷰). 이 파일에서 맨 처음 — 앞선 "없는 아이디" 로그인이 만들어 두지 않게', async () => {
    const started = performance.now();
    await dummyPasswordHash();
    expect(performance.now() - started).toBeLessThan(20);
  });

  it('로그인하면 200 내 정보와 httpOnly·SameSite=Strict 세션 쿠키. 토큰은 응답 본문에 없다', async () => {
    const res = await t.http(null).post('/auth/login').send({ loginId: 'op1', password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ loginId: 'op1', displayName: 'op1 이름', role: 'OPERATOR', merchantCode: null });
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0];
    expect(cookie).toMatch(/^sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict$/);
    const me = await withCookie(t, cookie.split(';')[0]).get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.loginId).toBe('op1');
    const account = await t.orm.em.fork().findOneOrFail(UserAccount, { loginId: 'op1' });
    expect(account.lastLoginAt).not.toBeNull();
  });

  it('Redis에는 토큰이 아니라 토큰의 SHA-256이 키로, 유휴 TTL과 함께 남는다', async () => {
    const cookie = await login(t, 'op1');
    const keys = await redis.keys(`${env.queuePrefix}:sess:*`);
    const token = cookie.slice('sid='.length);
    expect(keys.some((k) => k.endsWith(token))).toBe(false);
    expect(keys.every((k) => /:sess:[0-9a-f]{64}$/.test(k))).toBe(true);
    const ttl = await redis.pttl(keys[0]);
    expect(ttl).toBeGreaterThan(env.sessionIdleTtlMs - 60_000);
    expect(ttl).toBeLessThanOrEqual(env.sessionIdleTtlMs);
  });

  it('비밀번호가 틀리거나 없는 아이디면 같은 401 LOGIN_FAILED', async () => {
    const wrong = await t.http(null).post('/auth/login').send({ loginId: 'mon1', password: 'nope-nope-nope' });
    const unknown = await t.http(null).post('/auth/login').send({ loginId: 'ghost', password: 'nope-nope-nope' });
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.code).toBe('LOGIN_FAILED');
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('로그인 없이(쿠키·테스트 헤더 없음) 부르면 401 UNAUTHENTICATED, health는 열려 있다', async () => {
    const res = await t.http(null).get('/terminals');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ statusCode: 401, code: 'UNAUTHENTICATED' });
    expect((await t.http(null).get('/health')).status).toBe(200);
  });

  it('역할 밖이면 403 FORBIDDEN — 관제(MONITOR)는 읽기와 관제 작업만, 업무 쓰기는 못 한다', async () => {
    const mon = await login(t, 'mon1');
    expect((await withCookie(t, mon).get('/terminals')).status).toBe(200);
    expect((await withCookie(t, mon).get('/dashboard/summary')).status).toBe(200);
    const write = await withCookie(t, mon).post('/terminals').send({ serialNo: 'AU-0001', modelCode: 'SN-100' });
    expect(write.status).toBe(403);
    expect(write.body).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect((await withCookie(t, mon).post('/anomaly-scans')).status).toBe(200);
  });

  it('현장 작업자(FIELD)는 단말기 조회는 되고 운영 현황·업무 쓰기는 403', async () => {
    const field = await login(t, 'field1');
    expect((await withCookie(t, field).get('/terminals')).status).toBe(200);
    expect((await withCookie(t, field).get('/dashboard/summary')).status).toBe(403);
    expect((await withCookie(t, field).post('/terminals').send({ serialNo: 'AU-0002', modelCode: 'SN-100' })).status).toBe(403);
  });

  it('관리자(ADMIN)도 업무 쓰기는 못 한다(계정·키 관리 역할)', async () => {
    const admin = await login(t, 'admin1');
    expect((await withCookie(t, admin).get('/terminals')).status).toBe(200);
    expect((await withCookie(t, admin).post('/terminals').send({ serialNo: 'AU-0003', modelCode: 'SN-100' })).status).toBe(403);
  });

  it('이력의 작업자(actor)는 로그인 아이디다', async () => {
    const op = await login(t, 'op1');
    expect((await withCookie(t, op).post('/terminals').send({ serialNo: 'AU-0004', modelCode: 'SN-100' })).status).toBe(201);
    const history = await withCookie(t, op).get('/terminals/AU-0004/history');
    expect(history.body[0]).toMatchObject({ actor: 'op1', source: 'MANUAL' });
  });

  it('쿠키가 있으면 쿠키만 본다 — 끝난 세션 쿠키에 테스트 헤더를 붙여도 401', async () => {
    const res = await t.http(null).get('/terminals').set('Cookie', 'sid=not-a-real-session').set('X-Operator', 'kim');
    expect(res.status).toBe(401);
  });

  it('로그아웃하면 204, 쿠키를 지우고 그 세션은 더 쓸 수 없다', async () => {
    const op = await login(t, 'op1');
    const out = await withCookie(t, op).post('/auth/logout');
    expect(out.status).toBe(204);
    expect(([] as string[]).concat(out.headers['set-cookie'] ?? [])[0]).toMatch(/^sid=; Path=\/; Expires=Thu, 01 Jan 1970/);
    expect((await withCookie(t, op).get('/auth/me')).status).toBe(401);
  });

  it('계정의 세션을 모두 끊으면(역할 변경 등) 그 계정의 쿠키는 모두 401, 다른 계정은 그대로', async () => {
    const a = await login(t, 'op1');
    const b = await login(t, 'op1');
    const other = await login(t, 'mon1');
    const account = await t.orm.em.fork().findOneOrFail(UserAccount, { loginId: 'op1' });
    expect(await t.app.get(SessionStore).destroyAllFor(account.id)).toBeGreaterThanOrEqual(2);
    expect((await withCookie(t, a).get('/auth/me')).status).toBe(401);
    expect((await withCookie(t, b).get('/auth/me')).status).toBe(401);
    expect((await withCookie(t, other).get('/auth/me')).status).toBe(200);
  });

  it('사용 중지 계정은 맞는 비밀번호여도 401 LOGIN_FAILED', async () => {
    await createAccount(t, 'gone1', 'OPERATOR');
    await t.orm.em.fork().nativeUpdate(UserAccount, { loginId: 'gone1' }, { disabledAt: new Date() });
    const res = await t.http(null).post('/auth/login').send({ loginId: 'gone1', password: TEST_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('LOGIN_FAILED');
  });

  it(`같은 아이디로 ${env.loginMaxFailures}번 틀리면 맞는 비밀번호도 429 LOGIN_LOCKED, 다른 아이디는 영향 없음`, async () => {
    await createAccount(t, 'lock1', 'OPERATOR');
    for (let i = 0; i < env.loginMaxFailures; i++) {
      expect((await t.http(null).post('/auth/login').send({ loginId: 'lock1', password: 'wrong-wrong' })).status).toBe(401);
    }
    const locked = await t.http(null).post('/auth/login').send({ loginId: 'LOCK1', password: TEST_PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('LOGIN_LOCKED');
    const ttl = await redis.pttl(`${env.queuePrefix}:login-fail:lock1`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(env.loginLockMs);
    expect((await t.http(null).post('/auth/login').send({ loginId: 'op1', password: TEST_PASSWORD })).status).toBe(200);
  });

  it('가맹점이 없는 MERCHANT 계정(가맹점 삭제로 SET NULL)은 맞는 비밀번호여도 401 LOGIN_FAILED, 그런 세션도 401(Task 1 리뷰)', async () => {
    await createAccount(t, 'orphan1', 'MERCHANT');
    const res = await t.http(null).post('/auth/login').send({ loginId: 'orphan1', password: TEST_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('LOGIN_FAILED');
    const account = await t.orm.em.fork().findOneOrFail(UserAccount, { loginId: 'orphan1' });
    const store = t.app.get(SessionStore);
    const token = await store.create(
      { accountId: account.id, loginId: 'orphan1', displayName: 'orphan1 이름', role: Role.MERCHANT, merchantId: null, merchantCode: null },
      await store.generation(account.id),
    );
    expect((await withCookie(t, `sid=${token}`).get('/auth/me')).status).toBe(401);
  });

  it('테스트 전용 헤더: X-Test-Role로 역할을 바꾸고, MERCHANT·모르는 역할은 401', async () => {
    expect((await t.http({ 'X-Operator': 'm1', 'X-Test-Role': 'MONITOR' }).post('/terminals').send({ serialNo: 'AU-0005', modelCode: 'SN-100' })).status).toBe(403);
    expect((await t.http({ 'X-Operator': 'm1', 'X-Test-Role': 'MERCHANT' }).get('/auth/me')).status).toBe(401);
    expect((await t.http({ 'X-Operator': 'm1', 'X-Test-Role': 'ROOT' }).get('/auth/me')).status).toBe(401);
    expect((await t.http().get('/auth/me')).body).toEqual({ loginId: 'tester', displayName: 'tester', role: 'OPERATOR', merchantCode: null });
  });

  describe('보안 리뷰 반영(Task 2 리뷰) — 실패 제한·세션 세대값·절대 만료·로그인 요청 모양', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const sessionKeyOf = (cookie: string) => `${env.queuePrefix}:sess:${createHash('sha256').update(cookie.slice('sid='.length)).digest('hex')}`;

    it('악센트·전각 변형 아이디(collation이 같은 계정으로 보는 것)는 400 — 실패 카운터를 우회하지 못한다. 대소문자 변형은 같은 카운터', async () => {
      await createAccount(t, 'lock2', 'OPERATOR');
      for (const variant of ['lóck2', 'ｌｏｃｋ２', 'lock2 ', 'lo ck2']) {
        const res = await t.http(null).post('/auth/login').send({ loginId: variant, password: 'wrong-wrong' });
        expect(res.status, variant).toBe(400);
      }
      for (const variant of ['Lock2', 'LOCK2', 'lOcK2', 'Lock2', 'lock2'].slice(0, env.loginMaxFailures)) {
        expect((await t.http(null).post('/auth/login').send({ loginId: variant, password: 'wrong-wrong' })).status, variant).toBe(401);
      }
      const locked = await t.http(null).post('/auth/login').send({ loginId: 'lock2', password: TEST_PASSWORD });
      expect(locked.status).toBe(429);
    });

    it(`같은 아이디로 동시에 10번 틀려도 비밀번호 검증까지 가는 것은 ${env.loginMaxFailures}번까지(시도를 먼저 예약한다), 나머지는 429`, async () => {
      await createAccount(t, 'race1', 'OPERATOR');
      const statuses = await Promise.all(
        Array.from({ length: 10 }, () => t.http(null).post('/auth/login').send({ loginId: 'race1', password: 'wrong-wrong' }).then((r) => r.status)),
      );
      expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(env.loginMaxFailures);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(10 - env.loginMaxFailures);
      expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
    });

    it('로그인 도중(계정을 읽은 뒤·세션을 만들기 전) 그 계정의 세션을 모두 끊으면 새 세션도 무효(세대값)', async () => {
      await createAccount(t, 'gen1', 'OPERATOR');
      const store = t.app.get(SessionStore);
      const realCreate = store.create.bind(store);
      vi.spyOn(store, 'create').mockImplementationOnce(async (...args: Parameters<SessionStore['create']>) => {
        await store.destroyAllFor(args[0].accountId);
        return realCreate(...args);
      });
      const cookie = await login(t, 'gen1');
      expect((await withCookie(t, cookie).get('/auth/me')).status).toBe(401);
      // 끊긴 뒤 새로 로그인하면 새 세대값으로 쓸 수 있다
      expect((await withCookie(t, await login(t, 'gen1')).get('/auth/me')).status).toBe(200);
    });

    it('세션을 모두 끊는 도중(색인을 읽은 뒤·지우기 전) 옛 세대값으로 만든 세션도 무효', async () => {
      const account = await createAccount(t, 'gen2', 'OPERATOR');
      const store = t.app.get(SessionStore);
      const staleGen = await store.generation(account.id);
      const principal = { accountId: account.id, loginId: 'gen2', displayName: 'gen2 이름', role: Role.OPERATOR, merchantId: null, merchantCode: null };
      await store.create(principal, staleGen);
      let late: string | null = null;
      const realSmembers = redis.smembers.bind(redis) as (key: string) => Promise<string[]>;
      vi.spyOn(redis, 'smembers').mockImplementationOnce((async (key: string) => {
        const members = await realSmembers(key);
        late = await store.create(principal, staleGen);
        return members;
      }) as never);
      await store.destroyAllFor(account.id);
      expect(late).not.toBeNull();
      expect((await withCookie(t, `sid=${late}`).get('/auth/me')).status).toBe(401);
    });

    it('쓰고 있어도 로그인부터 SESSION_MAX_AGE_MS가 지나면 세션이 끝난다(절대 만료)', async () => {
      const cookie = await login(t, 'op1');
      const key = sessionKeyOf(cookie);
      const stored = JSON.parse((await redis.get(key))!) as Record<string, unknown>;
      expect(typeof stored.createdAt).toBe('number');
      await redis.set(key, JSON.stringify({ ...stored, createdAt: Date.now() - env.sessionMaxAgeMs - 1_000 }), 'PX', 60_000);
      expect((await withCookie(t, cookie).get('/auth/me')).status).toBe(401);
      expect(await redis.exists(key)).toBe(0);
    });

    it('세션 쿠키를 들고 다시 로그인하면 옛 세션을 지운다', async () => {
      const before = await login(t, 'op1');
      const res = await withCookie(t, before).post('/auth/login').send({ loginId: 'op1', password: TEST_PASSWORD });
      expect(res.status).toBe(200);
      const after = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0].split(';')[0];
      expect(after).not.toBe(before);
      expect((await withCookie(t, before).get('/auth/me')).status).toBe(401);
      expect((await withCookie(t, after).get('/auth/me')).status).toBe(200);
    });

    it('옛 세션 지우기가 실패해도(Redis 오류) 로그인은 성공하고 새 쿠키가 나간다 — 경고만 남긴다', async () => {
      const before = await login(t, 'op1');
      const destroy = vi.spyOn(t.app.get(SessionStore), 'destroy').mockRejectedValueOnce(new Error('redis down (test)'));
      try {
        const res = await withCookie(t, before).post('/auth/login').send({ loginId: 'op1', password: TEST_PASSWORD });
        expect(res.status).toBe(200);
        const after = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0].split(';')[0];
        expect(after).not.toBe(before);
        expect(destroy).toHaveBeenCalledTimes(1);
        expect((await withCookie(t, after).get('/auth/me')).status).toBe(200);
      } finally {
        destroy.mockRestore();
      }
    });

    it('JSON 헤더에 빈 본문(Content-Length: 0)이면 400 — type-is는 Content-Length가 있으면 본문이 있다고 봐 415 가드를 통과하고, 빈 객체가 검증에서 막힌다', async () => {
      // 리뷰는 415를 예상했지만 실제는 400(devlog 2026-10-28 보강 2 마감 항목, decisions/0050). 어느 쪽이든 쿠키는 나가지 않는다
      const res = await t.http(null).post('/auth/login').set('Content-Type', 'application/json');
      expect(res.status).toBe(400);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('로그인은 JSON 본문만 받는다 — 폼(urlencoded)·text는 415(다른 사이트 폼이 로그인시키지 못하게)', async () => {
      const form = await t.http(null).post('/auth/login').type('form').send(`loginId=op1&password=${encodeURIComponent(TEST_PASSWORD)}`);
      expect(form.status).toBe(415);
      expect(form.headers['set-cookie']).toBeUndefined();
      const text = await t.http(null).post('/auth/login').set('Content-Type', 'text/plain').send(JSON.stringify({ loginId: 'op1', password: TEST_PASSWORD }));
      expect(text.status).toBe(415);
    });
  });
});
