import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatusHistory } from '../src/terminal/terminal-status-history.entity.js';
import { registerInStock, SCENARIO_OP } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('terminal.status_changed_at — 지금 상태가 된 시각 (F4, decisions/0034)', () => {
  let t: TestApp;
  const em = () => t.orm.em.fork();
  const terminal = (serialNo: string) => em().findOneOrFail(Terminal, { serialNo });
  const lastHistory = async (serialNo: string) =>
    (await em().find(TerminalStatusHistory, { terminal: { serialNo } }, { orderBy: { id: 'desc' }, limit: 1 }))[0];

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('등록·전이마다 상태와 같은 UPDATE에서 바뀌고, 그 이력의 occurred_at과 같은 시각이다(이력은 초 단위라 1초 안)', async () => {
    const before = Date.now();
    await registerInStock(t, 'SC-0001'); // 등록 → 검수 합격 → 재고(전이 3번)
    const t1 = await terminal('SC-0001');
    expect(t1.status).toBe('IN_STOCK');
    expect(t1.statusChangedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(Math.abs(t1.statusChangedAt.getTime() - (await lastHistory('SC-0001')).occurredAt.getTime())).toBeLessThan(1000);

    await new Promise((r) => setTimeout(r, 1100));
    const res = await t.http().post('/terminals/SC-0001/allocations').set(SCENARIO_OP).send({ merchantCode: 'GANGNAM-KIMBAP', expectedVersion: t1.version });
    expect(res.status).toBe(201);
    const t2 = await terminal('SC-0001');
    expect(t2.statusChangedAt.getTime()).toBeGreaterThan(t1.statusChangedAt.getTime() + 1000);
    expect(Math.abs(t2.statusChangedAt.getTime() - (await lastHistory('SC-0001')).occurredAt.getTime())).toBeLessThan(1000);
  });

  it('거절된 전이(422)는 시각을 바꾸지 않는다', async () => {
    const before = await terminal('SC-0001');
    const res = await t.http().post('/terminals/SC-0001/transitions').set(SCENARIO_OP).send({ to: 'DISPOSED', reason: 'x', expectedVersion: before.version });
    expect(res.status).toBe(422);
    expect((await terminal('SC-0001')).statusChangedAt.getTime()).toBe(before.statusChangedAt.getTime());
  });
});
