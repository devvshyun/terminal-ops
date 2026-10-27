import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TransitionService } from '../src/terminal/transition.service.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'kim' };

describe('단말기 등록·조회 (F1)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('등록하면 RECEIVED, version 1로 만들어진다', async () => {
    const res = await t.http().post('/terminals').set(OP).send({ serialNo: 'T-0001', modelCode: 'SN-100' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ serialNo: 'T-0001', modelCode: 'SN-100', status: 'RECEIVED', version: 1 });
  });

  it('등록 이력이 작업자와 함께 남는다', async () => {
    const res = await t.http().get('/terminals/T-0001/history');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: 'RECEIVED', source: 'MANUAL', actor: 'kim', reason: '신규 등록' }),
    ]);
  });

  it('등록 이력도 전이 서비스가 남긴다(상태 변경 경로 일원화)', async () => {
    const spy = vi.spyOn(TransitionService.prototype, 'recordRegistration');
    try {
      const res = await t.http().post('/terminals').set(OP).send({ serialNo: 'REG-0001', modelCode: 'SN-100' });
      expect(res.status).toBe(201);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('한글 작업자 이름은 URL 인코딩해서 보낸다', async () => {
    const res = await t
      .http()
      .post('/terminals')
      .set({ 'X-Operator': encodeURIComponent('김운영') })
      .send({ serialNo: 'T-0002', modelCode: 'SN-200' });
    expect(res.status).toBe(201);
    const history = await t.http().get('/terminals/T-0002/history');
    expect(history.body[0].actor).toBe('김운영');
  });

  it('로그인(세션·테스트 헤더)이 없으면 401 UNAUTHENTICATED (보강 2 — 전에는 X-Operator가 없으면 400)', async () => {
    const res = await t.http(null).post('/terminals').send({ serialNo: 'T-0003', modelCode: 'SN-100' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('system: 으로 시작하는 작업자는 사람이 쓸 수 없다(테스트 헤더로도 401)', async () => {
    const res = await t.http(null).post('/terminals').set({ 'X-Operator': 'system:batch' }).send({ serialNo: 'T-0003', modelCode: 'SN-100' });
    expect(res.status).toBe(401);
  });

  it('같은 시리얼을 다시 등록하면 409 DUPLICATE', async () => {
    const res = await t.http().post('/terminals').set(OP).send({ serialNo: 'T-0001', modelCode: 'SN-100' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE');
  });

  it('없는 모델이면 404', async () => {
    const res = await t.http().post('/terminals').set(OP).send({ serialNo: 'T-0009', modelCode: 'SN-999' });
    expect(res.status).toBe(404);
  });

  it('시리얼 형식이 틀리면 400', async () => {
    const res = await t.http().post('/terminals').set(OP).send({ serialNo: 'bad serial', modelCode: 'SN-100' });
    expect(res.status).toBe(400);
  });

  it('상태·모델·시리얼 앞부분으로 검색하고 페이지를 나눈다', async () => {
    const byModel = await t.http().get('/terminals').query({ modelCode: 'SN-200' });
    expect(byModel.body.total).toBe(1);
    expect(byModel.body.items[0].serialNo).toBe('T-0002');

    const byPrefix = await t.http().get('/terminals').query({ q: 'T-000', size: 1, page: 2 });
    expect(byPrefix.body).toMatchObject({ total: 2, page: 2, size: 1 });
    expect(byPrefix.body.items).toHaveLength(1);

    const byStatus = await t.http().get('/terminals').query({ status: 'IN_STOCK' });
    expect(byStatus.body.total).toBe(0);
  });

  it('검색어의 % 는 와일드카드로 쓰이지 않는다', async () => {
    const res = await t.http().get('/terminals').query({ q: '%' });
    expect(res.body.total).toBe(0);
  });

  it('단건 조회, 없으면 404', async () => {
    expect((await t.http().get('/terminals/T-0001')).body.serialNo).toBe('T-0001');
    expect((await t.http().get('/terminals/NOPE-1')).status).toBe(404);
  });
});
