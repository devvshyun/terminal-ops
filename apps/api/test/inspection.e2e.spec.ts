import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'choi' };
const SN100_PASS = [
  { itemCode: 'POWER', passed: true },
  { itemCode: 'NETWORK', passed: true },
  { itemCode: 'CARD_READER', passed: true },
  { itemCode: 'PRINTER', passed: true },
];

describe('검수 체크리스트 (F13)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    for (const serialNo of ['IN-0001', 'IN-0002', 'IN-0003', 'IN-0004']) {
      await t.http().post('/terminals').set(OP).send({ serialNo, modelCode: 'SN-100' });
    }
    await t.http().post('/terminals').set(OP).send({ serialNo: 'IN-0201', modelCode: 'SN-200' });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('모델별 검수 항목을 순서대로 준다', async () => {
    const res = await t.http().get('/inspection-items').query({ modelCode: 'SN-200' });
    expect(res.status).toBe(200);
    expect(res.body.map((i: { code: string }) => i.code)).toEqual(['POWER', 'LTE', 'CARD_READER', 'BATTERY']);
  });

  it('전 항목 합격이면 INSPECTED, 검수 경로 이력이 남는다', async () => {
    const res = await t.http().post('/terminals/IN-0001/inspections').set(OP).send({ results: SN100_PASS });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ passed: true, failedItems: [], terminal: { status: 'INSPECTED' } });

    const history = await t.http().get('/terminals/IN-0001/history');
    expect(history.body.at(-1)).toMatchObject({ toStatus: 'INSPECTED', source: 'INSPECTION', actor: 'choi', reason: '검수 합격' });
  });

  it('하나라도 불합격이면 DEFECTIVE, 사유에 불합격 항목이 들어간다', async () => {
    const results = SN100_PASS.map((r) => (r.itemCode === 'PRINTER' ? { ...r, passed: false, note: '인쇄 흐림' } : r));
    const res = await t.http().post('/terminals/IN-0002/inspections').set(OP).send({ results });
    expect(res.body).toMatchObject({ passed: false, failedItems: ['PRINTER'], terminal: { status: 'DEFECTIVE' } });
    const history = await t.http().get('/terminals/IN-0002/history');
    expect(history.body.at(-1).reason).toBe('검수 불합격: PRINTER');
  });

  it('항목이 빠지거나 모르는 항목이 있으면 400, 상태 그대로', async () => {
    const res = await t
      .http()
      .post('/terminals/IN-0003/inspections')
      .set(OP)
      .send({ results: [...SN100_PASS.slice(0, 3), { itemCode: 'LTE', passed: true }] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ missing: ['PRINTER'], unknown: ['LTE'] });
    expect((await t.http().get('/terminals/IN-0003')).body.status).toBe('RECEIVED');
  });

  it('같은 항목을 두 번 보내면 400', async () => {
    const res = await t
      .http()
      .post('/terminals/IN-0003/inspections')
      .set(OP)
      .send({ results: [...SN100_PASS, { itemCode: 'POWER', passed: false }] });
    expect(res.status).toBe(400);
  });

  it('검수할 수 없는 상태(재고)면 422이고 검수 기록도 남지 않는다', async () => {
    const em = t.orm.em.fork();
    const terminal = await em.findOneOrFail(Terminal, { serialNo: 'IN-0004' });
    terminal.status = TerminalStatus.IN_STOCK;
    await em.flush();

    const res = await t.http().post('/terminals/IN-0004/inspections').set(OP).send({ results: SN100_PASS });
    expect(res.status).toBe(422);
    const stats = await t.http().get('/inspections/stats').query({ modelCode: 'SN-100' });
    const power = stats.body.find((s: { itemCode: string }) => s.itemCode === 'POWER');
    expect(power.total).toBe(2); // IN-0001, IN-0002만. IN-0004의 시도는 롤백됐다.
  });

  it('SN-200은 회수 후 재검수로 다시 INSPECTED가 될 수 있다', async () => {
    const em = t.orm.em.fork();
    const terminal = await em.findOneOrFail(Terminal, { serialNo: 'IN-0201' });
    terminal.status = TerminalStatus.RETURNED;
    await em.flush();

    const results = ['POWER', 'LTE', 'CARD_READER', 'BATTERY'].map((itemCode) => ({ itemCode, passed: true }));
    const res = await t.http().post('/terminals/IN-0201/inspections').set(OP).send({ results });
    expect(res.body.terminal.status).toBe('INSPECTED');
  });

  it('modelCode 없이 검수 항목을 조회하면 400', async () => {
    const res = await t.http().get('/inspection-items');
    expect(res.status).toBe(400);
  });

  it('불합격 통계: 항목별 검수 수·불합격 수·불합격률, 불합격 많은 순', async () => {
    const res = await t.http().get('/inspections/stats').query({ modelCode: 'SN-100' });
    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual({ modelCode: 'SN-100', itemCode: 'PRINTER', total: 2, failed: 1, failRate: 0.5 });
    expect(res.body.find((s: { itemCode: string }) => s.itemCode === 'POWER')).toEqual({
      modelCode: 'SN-100',
      itemCode: 'POWER',
      total: 2,
      failed: 0,
      failRate: 0,
    });
  });

  it('모델을 안 주면 전체 모델 통계', async () => {
    const res = await t.http().get('/inspections/stats');
    expect(new Set(res.body.map((s: { modelCode: string }) => s.modelCode))).toEqual(new Set(['SN-100', 'SN-200']));
  });

  it('통계 조회에 modelCode를 반복해서 주면 400', async () => {
    const res = await t.http().get('/inspections/stats?modelCode=SN-100&modelCode=SN-200');
    expect(res.status).toBe(400);
  });

  it('통계 조회에 빈 modelCode를 주면 400', async () => {
    const res = await t.http().get('/inspections/stats?modelCode=');
    expect(res.status).toBe(400);
  });
});
