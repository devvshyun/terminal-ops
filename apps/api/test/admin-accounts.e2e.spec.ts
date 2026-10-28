import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../src/auth/session.store.js';
import { UserAccount } from '../src/auth/user-account.entity.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { createAccount, login, withCookie } from './helpers/auth.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('계정 관리 ADMIN API (보강 2, decisions/0051·0050)', () => {
  let t: TestApp;
  let admin: string;
  let rootId: number;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    rootId = (await createAccount(t, 'root-admin', 'ADMIN')).id;
    admin = await login(t, 'root-admin');
  });
  afterAll(async () => {
    await deleteTestKeys(t.app.get<Redis>(REDIS));
    await t.app.close();
  });

  const create = (body: Record<string, unknown>) => withCookie(t, admin).post('/admin/accounts').send(body);

  it('ADMIN만 부를 수 있다(운영자도 403)', async () => {
    expect((await t.http().get('/admin/accounts')).status).toBe(403);
    expect((await withCookie(t, admin).get('/admin/accounts')).status).toBe(200);
  });

  it('계정을 만들면 201, 응답에 비밀번호·해시가 없다. 같은 아이디는 409 DUPLICATE', async () => {
    const res = await create({ loginId: 'new.op', displayName: '새 운영자', password: 'password-1234', role: 'OPERATOR' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ loginId: 'new.op', displayName: '새 운영자', role: 'OPERATOR', merchantCode: null, disabled: false, lastLoginAt: null });
    expect(JSON.stringify(res.body)).not.toMatch(/password|scrypt/);
    expect((await create({ loginId: 'new.op', displayName: 'x', password: 'password-1234', role: 'OPERATOR' })).body.code).toBe('DUPLICATE');
    expect((await t.http(null).post('/auth/login').send({ loginId: 'new.op', password: 'password-1234' })).status).toBe(200);
  });

  it('로그인 아이디는 로그인 규칙과 같다: 대문자를 받으면 소문자로 저장하고, 대소문자만 다른 아이디는 DUPLICATE, ASCII 밖 글자는 400', async () => {
    const res = await create({ loginId: 'Mixed.Case-Op', displayName: '대소문자', password: 'password-1234', role: 'OPERATOR' });
    expect(res.status).toBe(201);
    expect(res.body.loginId).toBe('mixed.case-op');
    expect((await t.orm.em.fork().findOneOrFail(UserAccount, { id: res.body.id })).loginId).toBe('mixed.case-op');
    // 저장된 소문자 아이디로, 그리고 대소문자를 섞어 써도 로그인된다(로그인은 소문자로 접는다)
    expect((await t.http(null).post('/auth/login').send({ loginId: 'MIXED.case-OP', password: 'password-1234' })).status).toBe(200);
    expect((await create({ loginId: 'MIXED.CASE-OP', displayName: 'x', password: 'password-1234', role: 'OPERATOR' })).body.code).toBe('DUPLICATE');
    for (const loginId of ['óp.accent', 'ｏｐ.wide', 'has space', 'ab', 'a'.repeat(51), 'trail.']) {
      const bad = await create({ loginId: loginId === 'trail.' ? 'bad/slash' : loginId, displayName: 'x', password: 'password-1234', role: 'OPERATOR' });
      expect(bad.status, loginId).toBe(400);
    }
  });

  it('입력 검증: 아이디 모양·비밀번호 10자·역할 값은 400, MERCHANT ⇔ 가맹점은 400 MERCHANT_REQUIRED, 없는 가맹점 404', async () => {
    expect((await create({ loginId: 'Bad Id', displayName: 'x', password: 'password-1234', role: 'OPERATOR' })).status).toBe(400);
    expect((await create({ loginId: 'short.pw', displayName: 'x', password: 'short', role: 'OPERATOR' })).status).toBe(400);
    expect((await create({ loginId: 'bad.role', displayName: 'x', password: 'password-1234', role: 'ROOT' })).status).toBe(400);
    const noMerchant = await create({ loginId: 'm.none', displayName: 'x', password: 'password-1234', role: 'MERCHANT' });
    expect([noMerchant.status, noMerchant.body.code]).toEqual([400, 'MERCHANT_REQUIRED']);
    const opWithMerchant = await create({ loginId: 'op.m', displayName: 'x', password: 'password-1234', role: 'OPERATOR', merchantCode: 'GANGNAM-KIMBAP' });
    expect([opWithMerchant.status, opWithMerchant.body.code]).toEqual([400, 'MERCHANT_REQUIRED']);
    expect((await create({ loginId: 'm.ghost', displayName: 'x', password: 'password-1234', role: 'MERCHANT', merchantCode: 'NOPE' })).status).toBe(404);
    const merchant = await create({ loginId: 'm.pangyo', displayName: '판교 점주', password: 'password-1234', role: 'MERCHANT', merchantCode: 'PANGYO-BUNSIK' });
    expect(merchant.body).toMatchObject({ role: 'MERCHANT', merchantCode: 'PANGYO-BUNSIK' });
  });

  it('역할을 바꾸면 그 계정의 세션이 끊기고, 다시 로그인하면 새 역할이다', async () => {
    const target = await createAccount(t, 'promote.me', 'MONITOR');
    const before = await login(t, 'promote.me');
    expect((await withCookie(t, before).post('/terminals').send({ serialNo: 'AD-0001', modelCode: 'SN-100' })).status).toBe(403);
    const res = await withCookie(t, admin).patch(`/admin/accounts/${target.id}`).send({ role: 'OPERATOR' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('OPERATOR');
    expect((await withCookie(t, before).get('/auth/me')).status).toBe(401);
    const after = await login(t, 'promote.me');
    expect((await withCookie(t, after).post('/terminals').send({ serialNo: 'AD-0001', modelCode: 'SN-100' })).status).toBe(201);
  });

  it('표시 이름만 바꾸면 세션은 그대로다', async () => {
    const target = await createAccount(t, 'rename.me', 'MONITOR');
    const cookie = await login(t, 'rename.me');
    expect((await withCookie(t, admin).patch(`/admin/accounts/${target.id}`).send({ displayName: '새 이름' })).body.displayName).toBe('새 이름');
    expect((await withCookie(t, cookie).get('/auth/me')).status).toBe(200);
  });

  it('사용 중지하면 세션이 끊기고 로그인도 안 된다. 다시 켜면 로그인된다', async () => {
    const target = await createAccount(t, 'disable.me', 'FIELD');
    const cookie = await login(t, 'disable.me');
    expect((await withCookie(t, admin).patch(`/admin/accounts/${target.id}`).send({ disabled: true })).body.disabled).toBe(true);
    expect((await withCookie(t, cookie).get('/auth/me')).status).toBe(401);
    expect((await t.http(null).post('/auth/login').send({ loginId: 'disable.me', password: 'test-password-1234' })).status).toBe(401);
    await withCookie(t, admin).patch(`/admin/accounts/${target.id}`).send({ disabled: false });
    expect((await t.http(null).post('/auth/login').send({ loginId: 'disable.me', password: 'test-password-1234' })).status).toBe(200);
  });

  it('MERCHANT로 바꾸려면 가맹점이 필요하고, 다른 역할로 바꾸면 가맹점이 지워진다', async () => {
    const target = await createAccount(t, 'switch.me', 'OPERATOR');
    expect((await withCookie(t, admin).patch(`/admin/accounts/${target.id}`).send({ role: 'MERCHANT' })).body.code).toBe('MERCHANT_REQUIRED');
    const m = await withCookie(t, admin).patch(`/admin/accounts/${target.id}`).send({ role: 'MERCHANT', merchantCode: 'YEOKSAM-CAFE' });
    expect(m.body).toMatchObject({ role: 'MERCHANT', merchantCode: 'YEOKSAM-CAFE' });
    const back = await withCookie(t, admin).patch(`/admin/accounts/${target.id}`).send({ role: 'MONITOR' });
    expect(back.body).toMatchObject({ role: 'MONITOR', merchantCode: null });
    expect((await withCookie(t, admin).patch('/admin/accounts/999999').send({ displayName: 'x' })).status).toBe(404);
  });

  it('세션 끊기(destroyAllFor)는 DB 변경이 커밋된 뒤에 부른다 — 부르는 순간 다른 연결에서 새 역할·중지가 보인다', async () => {
    const target = await createAccount(t, 'order.me', 'MONITOR');
    const store = t.app.get(SessionStore);
    const original = store.destroyAllFor.bind(store);
    const seen: Array<{ id: number; role: string; disabled: boolean }> = [];
    const spy = vi.spyOn(store, 'destroyAllFor').mockImplementation(async (id: number) => {
      const row = await t.orm.em.fork().findOneOrFail(UserAccount, id);
      seen.push({ id, role: row.role, disabled: row.disabledAt !== null });
      return original(id);
    });
    try {
      await withCookie(t, admin).patch(`/admin/accounts/${target.id}`).send({ role: 'FIELD' });
      await withCookie(t, admin).patch(`/admin/accounts/${target.id}`).send({ disabled: true });
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual([
      { id: target.id, role: 'FIELD', disabled: false },
      { id: target.id, role: 'FIELD', disabled: true },
    ]);
  });

  it('마지막 활성 ADMIN은 사용 중지도 강등도 못 한다(409 LAST_ADMIN) — 세션도 그대로', async () => {
    const disable = await withCookie(t, admin).patch(`/admin/accounts/${rootId}`).send({ disabled: true });
    expect([disable.status, disable.body.code]).toEqual([409, 'LAST_ADMIN']);
    const demote = await withCookie(t, admin).patch(`/admin/accounts/${rootId}`).send({ role: 'OPERATOR' });
    expect([demote.status, demote.body.code]).toEqual([409, 'LAST_ADMIN']);
    // 막힌 요청은 아무것도 바꾸지 않았다 — 계정은 그대로 ADMIN·활성이고 세션도 살아 있다
    const row = await t.orm.em.fork().findOneOrFail(UserAccount, rootId);
    expect([row.role, row.disabledAt]).toEqual(['ADMIN', null]);
    expect((await withCookie(t, admin).get('/auth/me')).status).toBe(200);
    // 다른 값(표시 이름, ADMIN 그대로, 사용 중지 false)은 마지막 ADMIN이어도 바꿀 수 있다
    expect((await withCookie(t, admin).patch(`/admin/accounts/${rootId}`).send({ displayName: '루트', role: 'ADMIN', disabled: false })).status).toBe(200);
  });

  it('ADMIN이 둘이면 하나는 내릴 수 있고, 남은 하나가 다시 마지막이 된다. 이미 사용 중지된 ADMIN을 내리는 것은 막지 않는다', async () => {
    const second = await createAccount(t, 'second-admin', 'ADMIN');
    expect((await withCookie(t, admin).patch(`/admin/accounts/${second.id}`).send({ disabled: true })).status).toBe(200);
    // second는 이미 중지 상태 — 활성 ADMIN은 root 하나뿐이라 root는 여전히 마지막
    expect((await withCookie(t, admin).patch(`/admin/accounts/${rootId}`).send({ role: 'MONITOR' })).body.code).toBe('LAST_ADMIN');
    // 중지된 ADMIN을 강등하는 것은 활성 ADMIN 수를 줄이지 않으므로 된다
    expect((await withCookie(t, admin).patch(`/admin/accounts/${second.id}`).send({ role: 'MONITOR' })).status).toBe(200);
    // 다시 켜서 둘이 되면 root를 내릴 수 있다
    const third = await createAccount(t, 'third-admin', 'ADMIN');
    expect((await withCookie(t, admin).patch(`/admin/accounts/${rootId}`).send({ role: 'MONITOR' })).status).toBe(200);
    expect((await withCookie(t, admin).get('/auth/me')).status).toBe(401);
    const thirdCookie = await login(t, 'third-admin');
    const last = await withCookie(t, thirdCookie).patch(`/admin/accounts/${third.id}`).send({ disabled: true });
    expect([last.status, last.body.code]).toEqual([409, 'LAST_ADMIN']);
  });
});
