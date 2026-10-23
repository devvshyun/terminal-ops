import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'lee' };

describe('상태 전이 API (F2)', () => {
  let t: TestApp;

  /** 테스트 준비용: 검수 기능 없이 상태를 직접 맞춘다. */
  async function forceStatus(serialNo: string, status: TerminalStatus) {
    const em = t.orm.em.fork();
    const terminal = await em.findOneOrFail(Terminal, { serialNo });
    terminal.status = status;
    await em.flush();
    return terminal.version;
  }

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await t.http().post('/terminals').set(OP).send({ serialNo: 'TR-0001', modelCode: 'SN-100' });
    await t.http().post('/terminals').set(OP).send({ serialNo: 'TR-0002', modelCode: 'SN-200' });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('허용된 전이는 200, version이 오르고 이력이 남는다', async () => {
    const version = await forceStatus('TR-0001', TerminalStatus.INSPECTED);
    const res = await t
      .http()
      .post('/terminals/TR-0001/transitions')
      .set(OP)
      .send({ to: 'IN_STOCK', reason: '검수 완료분 재고 편입', expectedVersion: version });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'IN_STOCK', version: version + 1 });

    const history = await t.http().get('/terminals/TR-0001/history');
    expect(history.body.at(-1)).toMatchObject({
      fromStatus: 'INSPECTED',
      toStatus: 'IN_STOCK',
      source: 'MANUAL',
      actor: 'lee',
      reason: '검수 완료분 재고 편입',
    });
  });

  it('expectedVersion이 현재와 다르면 409 VERSION_CONFLICT, 상태는 그대로', async () => {
    const res = await t
      .http()
      .post('/terminals/TR-0001/transitions')
      .set(OP)
      .send({ to: 'ALLOCATED', reason: '배정', expectedVersion: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    expect((await t.http().get('/terminals/TR-0001')).body.status).toBe('IN_STOCK');
  });

  it('일반 전이 API로는 배정·출고를 할 수 없다(배정·출고 API 전용 출처, decisions/0017)', async () => {
    const current = (await t.http().get('/terminals/TR-0001')).body.version;
    const allocate = await t
      .http()
      .post('/terminals/TR-0001/transitions')
      .set(OP)
      .send({ to: 'ALLOCATED', reason: '가맹점 없이 배정', expectedVersion: current });
    expect(allocate.status).toBe(422);
    expect(allocate.body.message).toContain('ALLOCATION 경로로만');

    const version = await forceStatus('TR-0001', TerminalStatus.ALLOCATED);
    const ship = await t
      .http()
      .post('/terminals/TR-0001/transitions')
      .set(OP)
      .send({ to: 'SHIPPED', reason: '운송장 없이 출고', expectedVersion: version });
    expect(ship.status).toBe(422);
    expect(ship.body.message).toContain('SHIPMENT 경로로만');
    await forceStatus('TR-0001', TerminalStatus.IN_STOCK);
  });

  it('허용되지 않은 전이는 422 INVALID_TRANSITION, 이력이 늘지 않는다', async () => {
    const before = (await t.http().get('/terminals/TR-0001/history')).body.length;
    const current = (await t.http().get('/terminals/TR-0001')).body.version;
    const res = await t
      .http()
      .post('/terminals/TR-0001/transitions')
      .set(OP)
      .send({ to: 'DISPOSED', reason: '폐기', expectedVersion: current });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_TRANSITION');
    expect((await t.http().get('/terminals/TR-0001/history')).body.length).toBe(before);
  });

  it('검수 전용 전이를 수동으로 하면 422', async () => {
    const current = (await t.http().get('/terminals/TR-0002')).body.version;
    const res = await t
      .http()
      .post('/terminals/TR-0002/transitions')
      .set(OP)
      .send({ to: 'INSPECTED', reason: '수동 합격', expectedVersion: current });
    expect(res.status).toBe(422);
  });

  it('재검수 필수 모델(SN-200)은 회수 후 바로 재고로 못 간다', async () => {
    const version = await forceStatus('TR-0002', TerminalStatus.RETURNED);
    const res = await t
      .http()
      .post('/terminals/TR-0002/transitions')
      .set(OP)
      .send({ to: 'IN_STOCK', reason: '재고 복귀', expectedVersion: version });
    expect(res.status).toBe(422);
    expect(res.body.message).toContain('재검수');
  });

  it('expectedVersion·reason이 없으면 400', async () => {
    const res = await t.http().post('/terminals/TR-0001/transitions').set(OP).send({ to: 'ALLOCATED' });
    expect(res.status).toBe(400);
  });

  it('reason이 공백뿐이면 400', async () => {
    const current = (await t.http().get('/terminals/TR-0001')).body.version;
    const res = await t
      .http()
      .post('/terminals/TR-0001/transitions')
      .set(OP)
      .send({ to: 'ALLOCATED', reason: '   ', expectedVersion: current });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.message)).toContain('공백');
  });

  it('없는 단말기는 404', async () => {
    const res = await t
      .http()
      .post('/terminals/NOPE-1/transitions')
      .set(OP)
      .send({ to: 'ALLOCATED', reason: 'x', expectedVersion: 1 });
    expect(res.status).toBe(404);
  });
});
