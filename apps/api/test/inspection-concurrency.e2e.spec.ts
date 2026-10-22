import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Inspection } from '../src/inspection/inspection.entities.js';
import { TerminalStatusHistory } from '../src/terminal/terminal-status-history.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const N = 10;
const OP = { 'X-Operator': 'choi' };
const SN100_PASS = ['POWER', 'NETWORK', 'CARD_READER', 'PRINTER'].map((itemCode) => ({ itemCode, passed: true }));

// 검수는 검수 기록 INSERT와 단말기 UPDATE를 한 트랜잭션에서 한다. 순서가 틀리면 데드락이 500으로 나간다
// (troubleshooting/0004, decisions/0006). experiments/0002.
describe(`동시 검수 실험: 같은 단말기에 검수 ${N}건 동시 요청`, () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await t.http().post('/terminals').set(OP).send({ serialNo: 'IC-0001', modelCode: 'SN-100' });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('C. 1건만 201, 나머지는 409 또는 422, 500 없음, 검수 기록·이력 1건', async () => {
    const started = performance.now();
    const responses = await Promise.all(
      Array.from({ length: N }, () => t.http().post('/terminals/IC-0001/inspections').set(OP).send({ results: SN100_PASS })),
    );
    const elapsed = Math.round(performance.now() - started);
    const byStatus = responses.reduce<Record<string, number>>((acc, r) => {
      const key = r.body?.code ? `${r.status} ${r.body.code}` : String(r.status);
      return { ...acc, [key]: (acc[key] ?? 0) + 1 };
    }, {});
    const em = t.orm.em.fork();
    const inspections = await em.count(Inspection, { terminal: { serialNo: 'IC-0001' } });
    const history = await em.count(TerminalStatusHistory, { terminal: { serialNo: 'IC-0001' }, toStatus: TerminalStatus.INSPECTED });
    console.log(`[실험 C] N=${N} 결과=${JSON.stringify(byStatus)} 검수기록=${inspections} 이력=${history} 소요=${elapsed}ms`);

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 500)).toHaveLength(0);
    for (const r of responses.filter((x) => x.status !== 201)) {
      expect([409, 422]).toContain(r.status);
      expect(['VERSION_CONFLICT', 'INVALID_TRANSITION']).toContain(r.body.code);
    }
    expect(inspections).toBe(1);
    expect(history).toBe(1);
  });
});
