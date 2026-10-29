import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PartnerKeyService } from '../src/auth/partner-key.service.js';
import { DEMO_PARTNER_KEY, seedDemoPartnerKey } from '../src/db/seed-accounts.js';
import { PartnerService } from '../src/partner/partner.service.js';
import { prepareInService } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

/** 연동 문서를 로그인 없이 받고, 문서의 응답 필드가 실제 응답과 같다(보강 7, decisions/0083) */
describe('GET /partner/v1/openapi.json', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await prepareInService(t, 'OA-0001', 'GANGNAM-KIMBAP');
    await seedDemoPartnerKey(t.orm.em.fork());
  });
  afterAll(async () => {
    await t.app.close();
  });

  const doc = async () => (await t.http(null).get('/partner/v1/openapi.json')).body;
  const keysOf = (schema: { properties: object; required: readonly string[] }) => ({ properties: Object.keys(schema.properties).sort(), required: [...schema.required].sort() });

  it('로그인·키 없이 JSON으로 받는다. 사내 경로는 없다', async () => {
    const res = await t.http(null).get('/partner/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.openapi).toBe('3.1.0');
    expect(Object.keys(res.body.paths).every((p) => p.startsWith('/partner/v1/'))).toBe(true);
  });

  it('단말기 응답의 키 = 문서 PartnerTerminal의 properties = required', async () => {
    const { PartnerTerminal } = (await doc()).components.schemas;
    const res = await t.http(null).get('/partner/v1/terminals/OA-0001').set('X-Api-Key', DEMO_PARTNER_KEY.key);
    expect(res.status).toBe(200);
    expect(keysOf(PartnerTerminal)).toEqual({ properties: Object.keys(res.body).sort(), required: Object.keys(res.body).sort() });
    expect(PartnerTerminal.properties.status.enum).toContain(res.body.status);
  });

  it('목록 응답의 키 = 문서 PartnerTerminalPage, 항목은 PartnerTerminal', async () => {
    const { PartnerTerminalPage, PartnerTerminal } = (await doc()).components.schemas;
    const res = await t.http(null).get('/partner/v1/merchants/GANGNAM-KIMBAP/terminals').set('Authorization', `Bearer ${DEMO_PARTNER_KEY.key}`);
    expect(res.status).toBe(200);
    expect(keysOf(PartnerTerminalPage).properties).toEqual(Object.keys(res.body).sort());
    expect(keysOf(PartnerTerminal).properties).toEqual(Object.keys(res.body.items[0]).sort());
  });

  it('오류 응답의 키는 문서 Error의 properties 안에 있다(403·400·401·404)', async () => {
    const { Error: ErrorSchema } = (await doc()).components.schemas;
    const allowed = Object.keys(ErrorSchema.properties);
    const partner = await t.app.get(PartnerService).create({ code: 'OA-SCOPE', name: '범위 시험' }, 'tester');
    const statusOnly = (await t.app.get(PartnerKeyService).create({ partnerId: partner.id, name: '상태만', scopes: ['terminal-status:read'] }, 'tester')).key;
    for (const res of [
      await t.http(null).get('/partner/v1/merchants/GANGNAM-KIMBAP/terminals').set('X-Api-Key', statusOnly),
      await t.http(null).get('/partner/v1/merchants/GANGNAM-KIMBAP/terminals?size=0').set('X-Api-Key', DEMO_PARTNER_KEY.key),
      await t.http(null).get('/partner/v1/terminals/OA-0001'),
      await t.http(null).get('/partner/v1/terminals/NOPE').set('X-Api-Key', DEMO_PARTNER_KEY.key),
    ]) {
      expect([400, 401, 403, 404]).toContain(res.status);
      expect(Object.keys(res.body).every((k) => allowed.includes(k)), JSON.stringify(res.body)).toBe(true);
      expect(ErrorSchema.required.every((k: string) => k in res.body)).toBe(true);
    }
  });
});
