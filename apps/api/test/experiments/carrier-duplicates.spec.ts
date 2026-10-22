import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CarrierSyncService } from '../../src/carrier-sync/carrier-sync.service.js';
import { CarrierEvent } from '../../src/shipment/shipment.entities.js';
import { TerminalStatusHistory } from '../../src/terminal/terminal-status-history.entity.js';
import { TerminalStatus } from '../../src/terminal/terminal-status.js';
import { countInTransit, maxDeliveredPerTerminal, prepareMany, syncRunTotals } from '../helpers/experiment.js';
import { partners } from '../helpers/partners.js';
import { resetQueues, waitForQueuesIdle } from '../helpers/queues.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

// experiments/0003. 실행: EXPERIMENTS=1 npx vitest run test/experiments/carrier-duplicates.spec.ts
const N = Number(process.env.EXP_N ?? 30);
const DUPLICATE_RATE = Number(process.env.EXP_DUP ?? 0.3);

describe(`실험 0003: 번개택배 중복 이벤트 (duplicateRate=${DUPLICATE_RATE}, 운송장 ${N}건)`, () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ workers: true });
    await resetDatabase(t.orm);
    await resetQueues(t.app);
    await partners.reset();
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await t.app.close();
  });

  it('중복 반영 0건: 이벤트는 운송장당 4개, DELIVERED 이력은 단말기당 1개', async () => {
    await prepareMany(t, 'EXP3', N, 'BUNGAE');
    await partners.configure({ seed: 3, bungae: { duplicateRate: DUPLICATE_RATE } });
    const sync = t.app.get(CarrierSyncService);

    const started = performance.now();
    let rounds = 0;
    while ((await countInTransit(t)) > 0 && rounds < 10) {
      await sync.sweep();
      await waitForQueuesIdle(t.app, 60_000);
      rounds += 1;
    }
    const elapsed = Math.round(performance.now() - started);

    const em = t.orm.em.fork();
    const events = await em.count(CarrierEvent);
    const delivered = await em.count(TerminalStatusHistory, { toStatus: TerminalStatus.DELIVERED });
    const maxPerTerminal = await maxDeliveredPerTerminal(t);
    const runs = await syncRunTotals(t);
    const stats = await partners.stats();
    // 조회 k번째 응답에는 서로 다른 이벤트가 k개 있다(1+2+3+4 = 10개/운송장). 그보다 많이 받은 만큼이 응답 안의 중복이다.
    const inResponseDuplicates = runs.fetched - 10 * N;
    console.log(
      `[실험 0003] N=${N} dup=${DUPLICATE_RATE} sweep=${rounds}회 조회=${stats.calls['bungae.track']} ` +
        `받은이벤트=${runs.fetched} 응답안중복=${inResponseDuplicates} 저장=${runs.inserted} 건너뜀=${runs.duplicated} ` +
        `carrier_event=${events} DELIVERED이력=${delivered} 단말기당최대=${maxPerTerminal} 결과=${JSON.stringify(runs.byOutcome)} 소요=${elapsed}ms`,
    );

    expect(events).toBe(N * 4);
    expect(runs.inserted).toBe(N * 4);
    expect(delivered).toBe(N);
    expect(maxPerTerminal).toBe(1);
    expect(inResponseDuplicates).toBeGreaterThan(0); // 골칫거리가 실제로 일어났는지
  }, 180_000);
});
