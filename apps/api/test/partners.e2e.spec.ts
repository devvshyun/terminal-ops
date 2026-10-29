import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PartnerApiKey } from '../src/auth/partner-key.entity.js';
import { createAccount, login, withCookie } from './helpers/auth.js';
import { prepareInService } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('외부 업체 등록과 업체별 키 (보강 7, decisions/0081)', () => {
  let t: TestApp;
  let admin: string;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await prepareInService(t, 'PT-0001', 'GANGNAM-KIMBAP');
    await createAccount(t, 'partner-admin', 'ADMIN');
    admin = await login(t, 'partner-admin');
  });
  afterAll(async () => {
    await t.app.close();
  });

  const createPartner = (body: object) => withCookie(t, admin).post('/admin/partners').send(body);

  it('ADMIN이 업체를 등록하고 목록에서 본다(키 0개)', async () => {
    const res = await createPartner({ code: 'HANOL-POS', name: '한올POS', memo: '가맹점 POS 연동' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code: 'HANOL-POS', name: '한올POS', memo: '가맹점 POS 연동', activeKeys: 0, totalKeys: 0, lastUsedAt: null, createdBy: 'partner-admin' });
    const list = await withCookie(t, admin).get('/admin/partners');
    expect(list.status).toBe(200);
    expect(list.body.map((p: { code: string }) => p.code)).toContain('HANOL-POS');
  });

  it('같은 코드는 409 DUPLICATE, 코드 모양·빈 이름·긴 메모는 400', async () => {
    const dup = await createPartner({ code: 'HANOL-POS', name: '다른 이름' });
    expect([dup.status, dup.body.code]).toEqual([409, 'DUPLICATE']);
    for (const body of [
      { code: 'hanol', name: 'x' },
      { code: 'A', name: 'x' },
      { code: 'A'.repeat(21), name: 'x' },
      { code: 'OK-1', name: '  ' },
      { code: 'OK-2', name: 'x', memo: 'm'.repeat(201) },
    ]) {
      expect((await createPartner(body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('ADMIN만 — 운영자·관제·로그인 없음은 막힌다', async () => {
    await createAccount(t, 'partner-op', 'OPERATOR');
    await createAccount(t, 'partner-mon', 'MONITOR');
    for (const id of ['partner-op', 'partner-mon']) {
      const cookie = await login(t, id);
      expect((await withCookie(t, cookie).get('/admin/partners')).status, id).toBe(403);
      expect((await withCookie(t, cookie).post('/admin/partners').send({ code: 'NOPE', name: 'x' })).status, id).toBe(403);
    }
    expect((await t.http(null).get('/admin/partners')).status).toBe(401);
  });

  it('키는 업체 하나에 속한다 — partnerId 없음 400, 없는 업체 404, 목록에 업체 코드·이름', async () => {
    const partner = (await createPartner({ code: 'KEYS-1', name: '키 업체' })).body;
    expect((await withCookie(t, admin).post('/admin/partner-keys').send({ name: '운영 서버', scopes: ['terminal-status:read'] })).status).toBe(400);
    expect((await withCookie(t, admin).post('/admin/partner-keys').send({ partnerId: 999999, name: '운영 서버', scopes: ['terminal-status:read'] })).status).toBe(404);
    const key = await withCookie(t, admin).post('/admin/partner-keys').send({ partnerId: partner.id, name: '운영 서버', scopes: ['terminal-status:read'] });
    expect(key.status).toBe(201);
    expect(key.body).toMatchObject({ partnerId: partner.id, partnerCode: 'KEYS-1', partnerName: '키 업체', name: '운영 서버' });
  });

  it('키 목록은 ?partnerId=로 거른다. 업체 목록의 키 수는 살아 있는 것·전체, 마지막 사용은 가장 늦은 것', async () => {
    const a = (await createPartner({ code: 'COUNT-A', name: '수 세기 A' })).body;
    const b = (await createPartner({ code: 'COUNT-B', name: '수 세기 B' })).body;
    const issue = (partnerId: number, name: string) =>
      withCookie(t, admin).post('/admin/partner-keys').send({ partnerId, name, scopes: ['terminal-status:read'] });
    const k1 = (await issue(a.id, '하나')).body;
    const k2 = (await issue(a.id, '둘')).body;
    await issue(b.id, '셋');
    await withCookie(t, admin).post(`/admin/partner-keys/${k2.id}/revoke`);
    const expired = (await issue(a.id, '만료')).body;
    await t.orm.em.fork().nativeUpdate(PartnerApiKey, { id: expired.id }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await t.http(null).get('/partner/v1/terminals/PT-0001').set('X-Api-Key', k1.key)).status).toBe(200);

    const onlyA = await withCookie(t, admin).get(`/admin/partner-keys?partnerId=${a.id}`);
    expect(onlyA.body.map((k: { name: string }) => k.name).sort()).toEqual(['둘', '만료', '하나']);
    expect((await withCookie(t, admin).get('/admin/partner-keys?partnerId=abc')).status).toBe(400);

    const list = (await withCookie(t, admin).get('/admin/partners')).body as { code: string; activeKeys: number; totalKeys: number; lastUsedAt: string | null }[];
    const rowA = list.find((p) => p.code === 'COUNT-A')!;
    expect([rowA.activeKeys, rowA.totalKeys]).toEqual([1, 3]);
    expect(rowA.lastUsedAt).not.toBeNull();
    expect(list.find((p) => p.code === 'COUNT-B')).toMatchObject({ activeKeys: 1, totalKeys: 1, lastUsedAt: null });
  });
});
