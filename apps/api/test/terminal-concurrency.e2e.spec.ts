import { OptimisticLockError } from '@mikro-orm/mysql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '../src/common/domain-errors.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatusHistory } from '../src/terminal/terminal-status-history.entity.js';
import { TerminalStatus, TransitionSource } from '../src/terminal/terminal-status.js';
import { TransitionService } from '../src/terminal/transition.service.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const N = 20;
const OP = { 'X-Operator': 'park' };

describe(`동시 수정 실험: 같은 단말기에 전이 ${N}건 동시 요청`, () => {
  let t: TestApp;

  async function setStatus(serialNo: string, status: TerminalStatus) {
    const em = t.orm.em.fork();
    const terminal = await em.findOneOrFail(Terminal, { serialNo });
    terminal.status = status;
    await em.flush();
    return terminal.version;
  }

  async function countHistory(serialNo: string, to: TerminalStatus) {
    return t.orm.em.fork().count(TerminalStatusHistory, { terminal: { serialNo }, toStatus: to });
  }

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await t.http().post('/terminals').set(OP).send({ serialNo: 'CC-0001', modelCode: 'SN-100' });
    await t.http().post('/terminals').set(OP).send({ serialNo: 'CC-0002', modelCode: 'SN-100' });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('A. 배정 API + 같은 expectedVersion: 1건만 201, 나머지는 409', async () => {
    const version = await setStatus('CC-0001', TerminalStatus.IN_STOCK);
    const started = performance.now();
    const responses = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        t
          .http()
          .post('/terminals/CC-0001/allocations')
          .set(OP)
          .send({ merchantCode: i % 2 ? 'YEOKSAM-CAFE' : 'GANGNAM-KIMBAP', expectedVersion: version }),
      ),
    );
    const elapsed = Math.round(performance.now() - started);
    const byStatus = responses.reduce<Record<number, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
    console.log(`[실험 A] N=${N} 결과=${JSON.stringify(byStatus)} 소요=${elapsed}ms`);

    expect(byStatus[201]).toBe(1);
    expect(byStatus[409]).toBe(N - 1);
    expect(await countHistory('CC-0001', TerminalStatus.ALLOCATED)).toBe(1);
  });

  it('B. 시스템 작업(expectedVersion 없음): 1건만 성공, 나머지는 충돌 또는 규칙 위반', async () => {
    await setStatus('CC-0002', TerminalStatus.ALLOCATED);
    const service = t.app.get(TransitionService);
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        service.transition(
          {
            serialNo: 'CC-0002',
            to: TerminalStatus.IN_STOCK,
            reason: `배정 취소 ${i}`,
            actor: 'system:experiment',
            source: TransitionSource.ALLOCATION,
          },
          t.orm.em.fork(),
        ),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const reasons = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason instanceof OptimisticLockError ? 'OptimisticLock' : r.reason instanceof InvalidTransitionError ? 'InvalidTransition' : String(r.reason)));
    const tally = reasons.reduce<Record<string, number>>((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {});
    console.log(`[실험 B] N=${N} 성공=${ok} 실패=${JSON.stringify(tally)}`);

    expect(ok).toBe(1);
    expect(Object.keys(tally).every((k) => k === 'OptimisticLock' || k === 'InvalidTransition')).toBe(true);
    expect(await countHistory('CC-0002', TerminalStatus.IN_STOCK)).toBe(1);
  });
});
