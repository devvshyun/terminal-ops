import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { registerInStock, SCENARIO_OP } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'han' };

describe('가맹점 배정 (F2)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await registerInStock(t, 'AL-0001');
    await registerInStock(t, 'AL-0002');
    await t.http().post('/terminals').set(SCENARIO_OP).send({ serialNo: 'AL-0003', modelCode: 'SN-100' });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('가맹점 3곳이 시드돼 있다', async () => {
    const res = await t.http().get('/merchants');
    expect(res.body.map((m: { name: string }) => m.name)).toEqual(['강남김밥', '판교분식', '역삼카페']);
  });

  it('배정하면 ALLOCATED + 가맹점이 한 번의 UPDATE로 바뀐다(version +1)', async () => {
    const before = (await t.http().get('/terminals/AL-0001')).body;
    expect(before.merchantCode).toBeNull();
    const res = await t
      .http()
      .post('/terminals/AL-0001/allocations')
      .set(OP)
      .send({ merchantCode: 'YEOKSAM-CAFE', expectedVersion: before.version });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'ALLOCATED', merchantCode: 'YEOKSAM-CAFE', version: before.version + 1 });

    const saved = await t.orm.em.fork().findOneOrFail(Terminal, { serialNo: 'AL-0001' }, { populate: ['merchant'] });
    expect(saved.merchant?.name).toBe('역삼카페');
    const history = await t.http().get('/terminals/AL-0001/history');
    expect(history.body.at(-1)).toMatchObject({
      toStatus: 'ALLOCATED',
      source: 'ALLOCATION',
      actor: 'han',
      reason: '가맹점 배정: 역삼카페(YEOKSAM-CAFE)',
    });
  });

  it('배정 취소: IN_STOCK으로 돌아가고 가맹점이 비워진다(UPDATE 한 번, version +1)', async () => {
    const before = (await t.http().get('/terminals/AL-0001')).body;
    expect(before.merchantCode).toBe('YEOKSAM-CAFE');
    const res = await t
      .http()
      .post('/terminals/AL-0001/allocation-cancellations')
      .set(OP)
      .send({ reason: '가맹점 개업 연기', expectedVersion: before.version });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'IN_STOCK', merchantCode: null, version: before.version + 1 });

    const saved = await t.orm.em.fork().findOneOrFail(Terminal, { serialNo: 'AL-0001' });
    expect(saved.merchant).toBeNull();
    const history = await t.http().get('/terminals/AL-0001/history');
    expect(history.body.at(-1)).toMatchObject({
      fromStatus: 'ALLOCATED',
      toStatus: 'IN_STOCK',
      source: 'ALLOCATION',
      actor: 'han',
      reason: '배정 취소: 가맹점 개업 연기',
    });
  });

  it('배정 취소는 ALLOCATED가 아니면 422, version이 다르면 409, reason이 없으면 400', async () => {
    const version = (await t.http().get('/terminals/AL-0002')).body.version;
    const notAllocated = await t.http().post('/terminals/AL-0002/allocation-cancellations').set(OP).send({ reason: '취소', expectedVersion: version });
    expect(notAllocated.status).toBe(422);
    const stale = await t.http().post('/terminals/AL-0002/allocation-cancellations').set(OP).send({ reason: '취소', expectedVersion: 1 });
    expect(stale.status).toBe(409);
    const noReason = await t.http().post('/terminals/AL-0002/allocation-cancellations').set(OP).send({ expectedVersion: version });
    expect(noReason.status).toBe(400);
  });

  it('없는 가맹점이면 404, 상태 그대로', async () => {
    const version = (await t.http().get('/terminals/AL-0002')).body.version;
    const res = await t.http().post('/terminals/AL-0002/allocations').set(OP).send({ merchantCode: 'NOPE', expectedVersion: version });
    expect(res.status).toBe(404);
    expect((await t.http().get('/terminals/AL-0002')).body).toMatchObject({ status: 'IN_STOCK', merchantCode: null });
  });

  it('version이 다르면 409, 가맹점도 안 바뀐다', async () => {
    const res = await t.http().post('/terminals/AL-0002/allocations').set(OP).send({ merchantCode: 'YEOKSAM-CAFE', expectedVersion: 1 });
    expect(res.status).toBe(409);
    expect((await t.http().get('/terminals/AL-0002')).body.merchantCode).toBeNull();
  });

  it('재고가 아닌 단말기는 422, 가맹점도 안 바뀐다', async () => {
    const version = (await t.http().get('/terminals/AL-0003')).body.version;
    const res = await t.http().post('/terminals/AL-0003/allocations').set(OP).send({ merchantCode: 'YEOKSAM-CAFE', expectedVersion: version });
    expect(res.status).toBe(422);
    expect((await t.http().get('/terminals/AL-0003')).body.merchantCode).toBeNull();
  });

  it('merchantCode·expectedVersion이 없으면 400', async () => {
    expect((await t.http().post('/terminals/AL-0002/allocations').set(OP).send({})).status).toBe(400);
  });
});
