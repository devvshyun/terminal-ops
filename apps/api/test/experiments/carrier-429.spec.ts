import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CarrierSyncService } from '../../src/carrier-sync/carrier-sync.service.js';
import { countInTransit, maxDeliveredPerTerminal, prepareMany, sleep, syncRunTotals } from '../helpers/experiment.js';
import { partners } from '../helpers/partners.js';
import { resetQueues, waitForQueuesIdle } from '../helpers/queues.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

// experiments/0004. 실행: EXPERIMENTS=1 npx vitest run test/experiments/carrier-429.spec.ts
const N = Number(process.env.EXP_N ?? 30);
const RATES = (process.env.EXP_RATES ?? '0.1,0.3,0.5').split(',').map(Number);
const SWEEP_EVERY_MS = 500; // 스케줄러 대신 테스트가 이 간격으로 sweep한다
const LIMIT_MS = 120_000; // 이 시간 안에 못 끝나면 미완료로 센다

describe(`실험 0004: 번개택배 429 비율별 수집 (운송장 ${N}건, 비율 ${RATES.join('/')})`, () => {
  let t: TestApp;
  const table: string[] = [];

  beforeAll(async () => {
    t = await createTestApp({ workers: true });
  });
  afterAll(async () => {
    console.log(['[실험 0004 요약]', '| 429 비율 | 완료 | 소요(ms) | 조회 | 429(강제/한도) | 재시도(ERROR 실행) | 재시도 소진 | 최대 시도 |', '|---|---|---|---|---|---|---|---|', ...table].join('\n'));
    await resetQueues(t.app);
    await t.app.close();
  });

  for (const rate of RATES) {
    it(`429 비율 ${rate * 100}%`, async () => {
      await resetDatabase(t.orm);
      await resetQueues(t.app);
      await partners.reset();
      await prepareMany(t, `EXP4-${rate * 100}`, N, 'BUNGAE');
      await partners.configure({ seed: 4, bungae: { force429Rate: rate, retryAfterSec: 1 } });
      const sync = t.app.get(CarrierSyncService);

      const started = performance.now();
      const deadline = Date.now() + LIMIT_MS;
      while ((await countInTransit(t)) > 0 && Date.now() < deadline) {
        await sync.sweep();
        await sleep(SWEEP_EVERY_MS);
      }
      const elapsed = Math.round(performance.now() - started);
      const remaining = await countInTransit(t);
      await waitForQueuesIdle(t.app, 30_000);

      const runs = await syncRunTotals(t);
      const stats = await partners.stats();
      const row = `| ${rate * 100}% | ${N - remaining}/${N} | ${elapsed} | ${stats.calls['bungae.track']} | ${stats.status429}(${stats.status429Forced}/${stats.status429Limit}) | ${runs.byOutcome.ERROR ?? 0} | ${runs.exhausted} | ${runs.maxAttempt} |`;
      table.push(row);
      console.log(`[실험 0004] rate=${rate} ${row} 결과=${JSON.stringify(runs.byOutcome)}`);

      expect(remaining).toBe(0); // 제한 시간 안에 모두 DELIVERED까지 가야 한다
      expect(await maxDeliveredPerTerminal(t)).toBeLessThanOrEqual(1); // 몇 번을 재시도해도 중복 반영은 없어야 한다
    }, LIMIT_MS + 120_000);
  }
});
