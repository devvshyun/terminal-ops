import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('단말기 키 (보강 2, decisions/0055)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
  });
  afterAll(async () => {
    await t.app.close();
  });

  const beat = { items: [{ serialNo: 'DK-0001', firmwareVersion: '1.0.0' }] };

  it.each(['/devices/heartbeats', '/devices/firmware-reports'])('%s: 키가 없거나 틀리면 401 UNAUTHENTICATED', async (path) => {
    const none = await t.http(null).post(path).send(beat);
    expect(none.status).toBe(401);
    expect(none.body.code).toBe('UNAUTHENTICATED');
    expect((await t.http(null).post(path).set('X-Device-Key', `${env.deviceApiKey}x`).send(beat)).status).toBe(401);
    expect((await t.http(null).post(path).set('X-Device-Key', env.deviceApiKey.slice(0, -1)).send(beat)).status).toBe(401);
  });

  it('맞는 키면 사람 로그인 없이 받는다(하트비트 행별 결과)', async () => {
    const res = await t.http(null).post('/devices/heartbeats').set('X-Device-Key', env.deviceApiKey).send(beat);
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
  });

  it('사람 세션·테스트 헤더만으로는 단말기 API를 부를 수 없다', async () => {
    expect((await t.http(null).post('/devices/heartbeats').set('X-Operator', 'kim').send(beat)).status).toBe(401);
  });

  it('단말기 키로는 사람 API를 부를 수 없다', async () => {
    expect((await t.http(null).get('/terminals').set('X-Device-Key', env.deviceApiKey)).status).toBe(401);
  });
});
