import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PartnerApiKey } from '../src/auth/partner-key.entity.js';
import { PartnerKeyService } from '../src/auth/partner-key.service.js';
import { DEMO_PARTNER_KEY, seedDemoPartnerKey } from '../src/db/seed-accounts.js';
import { createAccount, login, withCookie } from './helpers/auth.js';
import { partners } from './helpers/partners.js';
import { prepareInService, registerInStock } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('외부 업체 API 키 (보강 2, decisions/0054)', () => {
  let t: TestApp;
  let admin: string;
  let statusOnly: string;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await partners.reset();
    await prepareInService(t, 'PK-0001', 'GANGNAM-KIMBAP');
    await registerInStock(t, 'PK-0002');
    await createAccount(t, 'key-admin', 'ADMIN');
    admin = await login(t, 'key-admin');
  });
  afterAll(async () => {
    await t.app.close();
  });

  const terminal = (serial: string) => t.http(null).get(`/partner/v1/terminals/${serial}`);

  it('ADMIN이 발급하면 원문은 응답에 한 번만, DB에는 접두사와 SHA-256만', async () => {
    expect((await t.http().post('/admin/partner-keys').send({ name: 'x', scopes: ['terminal-status:read'] })).status).toBe(403);
    const res = await withCookie(t, admin).post('/admin/partner-keys').send({ name: '연동 업체 A', scopes: ['terminal-status:read'] });
    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/^pk_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(res.body).toMatchObject({ name: '연동 업체 A', prefix: res.body.key.slice(0, 11), scopes: ['terminal-status:read'], createdBy: 'key-admin', revokedAt: null, lastUsedAt: null });
    statusOnly = res.body.key;
    const row = await t.orm.em.fork().findOneOrFail(PartnerApiKey, { prefix: res.body.prefix });
    expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(statusOnly.slice(12));
    const list = await withCookie(t, admin).get('/admin/partner-keys');
    expect(list.body[0]).not.toHaveProperty('key');
  });

  it('Bearer 또는 X-Api-Key로 단말기 상태를 읽는다(외부용 좁은 응답)', async () => {
    const bearer = await terminal('PK-0001').set('Authorization', `Bearer ${statusOnly}`);
    expect(bearer.status).toBe(200);
    expect(bearer.body).toEqual({ serialNo: 'PK-0001', modelCode: 'SN-100', status: 'IN_SERVICE', merchantCode: 'GANGNAM-KIMBAP' });
    expect((await terminal('PK-0002').set('X-Api-Key', statusOnly)).body.status).toBe('IN_STOCK');
    expect((await terminal('NOPE-1').set('X-Api-Key', statusOnly)).status).toBe(404);
  });

  it('키가 없거나 모양·값이 틀리면 401, scope 밖이면 403', async () => {
    expect((await terminal('PK-0001')).status).toBe(401);
    expect((await terminal('PK-0001').set('X-Api-Key', 'pk_nope')).status).toBe(401);
    const tampered = `${statusOnly.slice(0, -1)}${statusOnly.endsWith('A') ? 'B' : 'A'}`;
    expect((await terminal('PK-0001').set('X-Api-Key', tampered)).status).toBe(401);
    const scoped = await t.http(null).get('/partner/v1/merchants/GANGNAM-KIMBAP/terminals').set('X-Api-Key', statusOnly);
    expect([scoped.status, scoped.body.code]).toEqual([403, 'FORBIDDEN']);
  });

  it('사람 세션·테스트 헤더로는 외부 업체 API를 부를 수 없고, 외부 업체 키로는 사내 API를 부를 수 없다', async () => {
    expect((await withCookie(t, admin).get('/partner/v1/terminals/PK-0001')).status).toBe(401);
    expect((await t.http().get('/partner/v1/terminals/PK-0001')).status).toBe(401);
    expect((await t.http(null).get('/terminals/PK-0001').set('Authorization', `Bearer ${statusOnly}`)).status).toBe(401);
  });

  it('쓰면 lastUsedAt이 남는다(1분에 한 번만 갱신)', async () => {
    const svc = t.app.get(PartnerKeyService);
    const first = await withCookie(t, admin).get('/admin/partner-keys');
    const used = first.body.find((k: { key?: string; prefix: string }) => k.prefix === statusOnly.slice(0, 11)).lastUsedAt as string;
    expect(used).not.toBeNull();
    await svc.verify(statusOnly, new Date(Date.parse(used) + 30_000));
    expect((await t.orm.em.fork().findOneOrFail(PartnerApiKey, { prefix: statusOnly.slice(0, 11) })).lastUsedAt?.toISOString()).toBe(new Date(used).toISOString());
    // 열이 datetime(초 단위)이라 MySQL이 밀리초를 반올림한다 — 비교가 흔들리지 않게 정확한 초로 준다
    const later = new Date(Math.ceil((Date.parse(used) + 61_000) / 1000) * 1000);
    await svc.verify(statusOnly, later);
    expect((await t.orm.em.fork().findOneOrFail(PartnerApiKey, { prefix: statusOnly.slice(0, 11) })).lastUsedAt!.getTime()).toBe(later.getTime());
  });

  it('폐기하면 바로 401. 다시 폐기해도 처음 시각 그대로', async () => {
    const created = await withCookie(t, admin).post('/admin/partner-keys').send({ name: '연동 업체 B', scopes: ['terminal-status:read'] });
    expect((await terminal('PK-0001').set('X-Api-Key', created.body.key)).status).toBe(200);
    const revoked = await withCookie(t, admin).post(`/admin/partner-keys/${created.body.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedAt).not.toBeNull();
    expect((await terminal('PK-0001').set('X-Api-Key', created.body.key)).status).toBe(401);
    expect((await withCookie(t, admin).post(`/admin/partner-keys/${created.body.id}/revoke`)).body.revokedAt).toBe(revoked.body.revokedAt);
    expect((await withCookie(t, admin).post('/admin/partner-keys/999999/revoke')).status).toBe(404);
  });

  it('만료 시각이 지나면 401', async () => {
    const created = await withCookie(t, admin)
      .post('/admin/partner-keys')
      .send({ name: '연동 업체 C', scopes: ['terminal-status:read'], expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect((await terminal('PK-0001').set('X-Api-Key', created.body.key)).status).toBe(200);
    await t.orm.em.fork().nativeUpdate(PartnerApiKey, { id: created.body.id }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await terminal('PK-0001').set('X-Api-Key', created.body.key)).status).toBe(401);
  });

  it('시연 키(시드)는 두 scope 모두 — 가맹점 단말기 목록을 쪽 단위로 읽는다. 없는 가맹점은 404', async () => {
    expect(await seedDemoPartnerKey(t.orm.em.fork())).toBe(true);
    expect(await seedDemoPartnerKey(t.orm.em.fork())).toBe(false);
    const res = await t.http(null).get('/partner/v1/merchants/GANGNAM-KIMBAP/terminals').set('Authorization', `Bearer ${DEMO_PARTNER_KEY.key}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, page: 1, size: 50, items: [{ serialNo: 'PK-0001', status: 'IN_SERVICE' }] });
    expect((await t.http(null).get('/partner/v1/merchants/NOPE/terminals').set('X-Api-Key', DEMO_PARTNER_KEY.key)).status).toBe(404);
  });

  it('발급 입력 검증: 모르는 scope·빈 scope·빈 이름은 400', async () => {
    for (const body of [
      { name: 'x', scopes: ['admin:all'] },
      { name: 'x', scopes: [] },
      { name: '  ', scopes: ['terminal-status:read'] },
      { name: 'x', scopes: ['terminal-status:read'], expiresAt: 'tomorrow' },
    ]) {
      expect((await withCookie(t, admin).post('/admin/partner-keys').send(body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});
