import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'han' };

/**
 * 등록된 펌웨어 목록 GET /firmware(보강 5, decisions/0066). 어드민 배포 만들기 화면이 모델을 고르면 그 모델의 버전을 선택지로 보인다.
 * 최근 등록부터 beforeId 키셋(decisions/0039), 모델로 거르기, 역할은 배포 목록과 같은 사무실 역할(OFFICE).
 */
describe('등록된 펌웨어 목록 /firmware (보강 5)', () => {
  let t: TestApp;
  const ids = (body: { items: { id: number }[] }) => body.items.map((i) => i.id);

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    for (const [modelCode, version] of [
      ['SN-100', '1.1.0'],
      ['SN-300', '3.0.0'],
      ['SN-100', '1.2.0'],
      ['SN-100', '1.3.0-rc1'],
    ]) {
      expect((await t.http().post('/firmware').set(OP).send({ modelCode, version })).status).toBe(201);
    }
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('최근 등록부터 limit개와 nextBeforeId, 다음 쪽은 beforeId로', async () => {
    const first = await t.http().get('/firmware').query({ limit: 3 });
    expect(first.status).toBe(200);
    expect(first.body.items.map((f: { version: string }) => f.version)).toEqual(['1.3.0-rc1', '1.2.0', '3.0.0']);
    expect(first.body.items[0]).toEqual({
      id: expect.any(Number),
      modelCode: 'SN-100',
      version: '1.3.0-rc1',
      createdBy: 'han',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(first.body.nextBeforeId).toBe(first.body.items[2].id);
    const next = await t.http().get('/firmware').query({ limit: 3, beforeId: first.body.nextBeforeId });
    expect(next.body.items.map((f: { version: string }) => f.version)).toEqual(['1.1.0']);
    expect(next.body.nextBeforeId).toBeNull();
    expect(ids(next.body).every((id) => id < first.body.nextBeforeId)).toBe(true);
  });

  it('모델로 거른다 — 없는 모델은 빈 목록(404가 아니다), 길이를 넘는 모델 코드는 400', async () => {
    const sn100 = await t.http().get('/firmware').query({ modelCode: 'SN-100' });
    expect(sn100.body.items.map((f: { version: string }) => f.version)).toEqual(['1.3.0-rc1', '1.2.0', '1.1.0']);
    expect((await t.http().get('/firmware').query({ modelCode: 'SN-300' })).body.items.map((f: { version: string }) => f.version)).toEqual(['3.0.0']);
    expect((await t.http().get('/firmware').query({ modelCode: 'SN-999' })).body).toEqual({ items: [], nextBeforeId: null });
    expect((await t.http().get('/firmware').query({ modelCode: 'X'.repeat(21) })).status).toBe(400);
  });

  it('역할: 사무실 역할(관제·ADMIN)은 읽고, 현장 작업자는 403, 로그인 없으면 401', async () => {
    expect((await t.http({ 'X-Operator': 'mon', 'X-Test-Role': 'MONITOR' }).get('/firmware')).status).toBe(200);
    expect((await t.http({ 'X-Operator': 'adm', 'X-Test-Role': 'ADMIN' }).get('/firmware')).status).toBe(200);
    const field = await t.http({ 'X-Operator': 'fld', 'X-Test-Role': 'FIELD' }).get('/firmware');
    expect(field.status).toBe(403);
    expect(field.body.code).toBe('FORBIDDEN');
    expect((await t.http(null).get('/firmware')).status).toBe(401);
  });
});
