import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PartnerCall } from '../src/partner/partner-call.entity.js';
import { PartnerCallService } from '../src/partner/partner-call.service.js';
import { createAccount, login, withCookie } from './helpers/auth.js';
import { prepareInService } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

interface CallRow {
  id: number;
  partnerId: number;
  partnerCode: string;
  keyId: number;
  keyPrefix: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

describe('외부용 API 호출 기록 (보강 7, decisions/0082)', () => {
  let t: TestApp;
  let admin: string;
  let partnerA: number;
  let partnerB: number;
  let keyA: { id: number; key: string; prefix: string };
  let keyB: { id: number; key: string };

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await prepareInService(t, 'PC-0001', 'GANGNAM-KIMBAP');
    await createAccount(t, 'calls-admin', 'ADMIN');
    admin = await login(t, 'calls-admin');
    const partner = async (code: string) => (await withCookie(t, admin).post('/admin/partners').send({ code, name: code })).body.id as number;
    partnerA = await partner('CALLS-A');
    partnerB = await partner('CALLS-B');
    const issue = async (partnerId: number, scopes: string[]) => (await withCookie(t, admin).post('/admin/partner-keys').send({ partnerId, name: '시험', scopes })).body;
    keyA = await issue(partnerA, ['terminal-status:read']);
    keyB = await issue(partnerB, ['terminal-status:read', 'merchant-terminals:read']);
  });
  afterAll(async () => {
    await t.app.close();
  });

  /** 기록은 응답이 끝난 뒤 기다리지 않고 쓴다 — 표에 n줄이 될 때까지 기다린다 */
  const waitForCalls = async (n: number) => {
    await vi.waitFor(async () => expect(await t.orm.em.fork().count(PartnerCall)).toBe(n), { timeout: 3000, interval: 25 });
  };
  const calls = async (query = '') => (await withCookie(t, admin).get(`/admin/partner-calls${query}`)).body as { items: CallRow[]; nextBeforeId: number | null };

  it('200·404·403(scope 밖)은 남고, 401(키 없음·틀림·폐기)은 남지 않는다', async () => {
    expect((await t.http(null).get('/partner/v1/terminals/PC-0001?x=1').set('X-Api-Key', keyA.key)).status).toBe(200);
    expect((await t.http(null).get('/partner/v1/terminals/NOPE-1').set('Authorization', `Bearer ${keyA.key}`)).status).toBe(404);
    expect((await t.http(null).get('/partner/v1/merchants/GANGNAM-KIMBAP/terminals').set('X-Api-Key', keyA.key)).status).toBe(403);
    expect((await t.http(null).get('/partner/v1/terminals/PC-0001')).status).toBe(401);
    expect((await t.http(null).get('/partner/v1/terminals/PC-0001').set('X-Api-Key', `${keyA.key.slice(0, -1)}x`)).status).toBe(401);
    await waitForCalls(3);

    const page = await calls();
    expect(page.items.map((c) => [c.method, c.path, c.status])).toEqual([
      ['GET', '/partner/v1/merchants/GANGNAM-KIMBAP/terminals', 403],
      ['GET', '/partner/v1/terminals/NOPE-1', 404],
      ['GET', '/partner/v1/terminals/PC-0001', 200], // 쿼리는 빼고
    ]);
    expect(page.items[0]).toMatchObject({ partnerId: partnerA, partnerCode: 'CALLS-A', keyId: keyA.id, keyPrefix: keyA.prefix });
    expect(page.items.every((c) => Number.isInteger(c.durationMs) && c.durationMs >= 0)).toBe(true);
    expect(page.nextBeforeId).toBeNull();
  });

  it('업체·키로 거르고, 최근부터 limit개씩 이어 본다', async () => {
    for (let i = 0; i < 3; i += 1) await t.http(null).get('/partner/v1/merchants/GANGNAM-KIMBAP/terminals').set('X-Api-Key', keyB.key);
    await waitForCalls(6);
    expect((await calls(`?partnerId=${partnerB}`)).items.map((c) => c.partnerCode)).toEqual(['CALLS-B', 'CALLS-B', 'CALLS-B']);
    expect((await calls(`?keyId=${keyA.id}`)).items).toHaveLength(3);
    const first = await calls('?limit=4');
    expect(first.items).toHaveLength(4);
    const second = await calls(`?limit=4&beforeId=${first.nextBeforeId}`);
    expect(second.items.map((c) => c.id)).toEqual([...second.items.map((c) => c.id)].sort((a, b) => b - a));
    expect([...first.items, ...second.items].map((c) => c.id)).toHaveLength(6);
    expect(second.nextBeforeId).toBeNull();
    expect((await withCookie(t, admin).get('/admin/partner-calls?limit=101')).status).toBe(400);
  });

  it('ADMIN만 본다', async () => {
    await createAccount(t, 'calls-mon', 'MONITOR');
    expect((await withCookie(t, await login(t, 'calls-mon')).get('/admin/partner-calls')).status).toBe(403);
    expect((await t.http(null).get('/admin/partner-calls').set('X-Api-Key', keyB.key)).status).toBe(401);
  });

  it('기록 쓰기가 실패해도 외부 업체 응답은 그대로 200이다', async () => {
    const service = t.app.get(PartnerCallService);
    const insert = vi.spyOn(service, 'insert').mockRejectedValueOnce(new Error('DB가 잠깐 끊김'));
    try {
      expect((await t.http(null).get('/partner/v1/terminals/PC-0001').set('X-Api-Key', keyA.key)).status).toBe(200);
      await vi.waitFor(() => expect(insert).toHaveBeenCalledTimes(1));
    } finally {
      insert.mockRestore();
    }
    expect(await t.orm.em.fork().count(PartnerCall)).toBe(6);
  });
});
