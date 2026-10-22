import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CarrierSyncService } from '../../src/carrier-sync/carrier-sync.service.js';
import { env } from '../../src/config/env.js';
import { OutboxEvent, OutboxStatus } from '../../src/outbox/outbox-event.entity.js';
import { OutboxService } from '../../src/outbox/outbox.service.js';
import { countInTransit, maxDeliveredPerTerminal, prepareMany, sleep, syncRunTotals } from '../helpers/experiment.js';
import { partners } from '../helpers/partners.js';
import { resetQueues, waitForQueuesIdle } from '../helpers/queues.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

// experiments/0005. 실행: npm run build && EXPERIMENTS=1 npx vitest run test/experiments/two-workers.spec.ts
// 두 설정을 차례로 돈다. 설정마다 워커 2개를 새로 띄운다(limiter 값은 워커 시작 때 정해지므로).
const N = Number(process.env.EXP_N ?? 30);
const WORKER_JS = resolve(process.cwd(), 'dist/worker.js');

interface Variant {
  name: string;
  /** 워커 프로세스의 BullMQ limiter(초당, 큐 단위라 두 워커 합산) */
  bungaeRatePerSec: number;
  /** partners 번개택배 초당 한도. limiter보다 높아야 429가 나지 않는다 */
  partnersRateLimitPerSec: number;
}

const VARIANTS: Variant[] = [
  // 원래 설정: limiter 초당 10. 응답 100ms라 두 워커를 합쳐도 거의 한 줄로 처리된다.
  { name: 'base', bungaeRatePerSec: 10, partnersRateLimitPerSec: 20 },
  // 높은 한도: limiter가 거의 막지 않아 두 워커의 concurrency(5+5)만큼 실제로 겹쳐 돈다.
  { name: 'high-rate', bungaeRatePerSec: 500, partnersRateLimitPerSec: 10_000 },
];

/** 끝나기를 기다리고, 시간 안에 안 끝나면 PID로 강제 종료한다. */
async function stopChild(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  const timedOut = await Promise.race([exited.then(() => false), sleep(timeoutMs).then(() => true)]);
  if (timedOut && child.pid !== undefined) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // 이미 끝났다
    }
    await Promise.race([exited, sleep(5_000)]);
  }
}

/**
 * dist/worker.js를 자식 프로세스로 띄워 workers에 바로 넣고, "worker ready"가 찍힐 때까지 기다린다.
 * 바로 넣어 두기 때문에 다음 워커 시작이 실패해도 afterAll이 이 워커를 정리한다. 준비 실패·시간 초과면 그 자리에서 죽인다.
 */
async function startWorker(name: string, variant: Variant, workers: ChildProcess[]): Promise<ChildProcess> {
  const child = spawn(process.execPath, [WORKER_JS], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      QUEUE_PREFIX: env.queuePrefix,
      WORKER_NAME: name,
      RUN_SCHEDULERS: '0',
      BUNGAE_RATE_PER_SEC: String(variant.bungaeRatePerSec),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  workers.push(child);
  try {
    await new Promise<void>((ready, fail) => {
      const timer = setTimeout(() => fail(new Error(`${name}가 15초 안에 준비되지 않았습니다.`)), 15_000);
      child.stdout!.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('worker ready')) {
          clearTimeout(timer);
          ready();
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        fail(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        fail(new Error(`${name}가 종료됐습니다(exit ${code}).`));
      });
    });
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return child;
}

for (const variant of VARIANTS) {
  describe(`실험 0005 [${variant.name}]: 워커 프로세스 2개가 같은 큐를 나눠 처리 (운송장 ${N}건, limiter 초당 ${variant.bungaeRatePerSec})`, () => {
    let t: TestApp | undefined;
    const workers: ChildProcess[] = [];

    beforeAll(async () => {
      if (!existsSync(WORKER_JS)) throw new Error('dist/worker.js가 없습니다. 먼저 npm run build 하세요.');
      // 이 테스트 프로세스는 job을 넣기만 한다(workers: false). 처리는 자식 프로세스 2개가 한다.
      t = await createTestApp({ workers: false });
      await resetDatabase(t.orm);
      await resetQueues(t.app);
      await partners.reset();
      await startWorker('w1', variant, workers);
      await startWorker('w2', variant, workers);
    }, 60_000);
    afterAll(async () => {
      await Promise.all(workers.map((w) => stopChild(w)));
      if (t?.app) {
        await resetQueues(t.app);
        await t.app.close();
      }
    }, 60_000);

    it('DELIVERED 이력 중복 0, 톡톡 중복 수신 0, 전역 동시 처리 수를 잰다', async () => {
      const app = t!;
      await prepareMany(app, 'EXP5', N, 'BUNGAE');
      // 응답을 늦춰 두 워커가 겹칠 기회를 넓힌다.
      await partners.configure({ seed: 5, bungae: { delayMs: 100, rateLimitPerSec: variant.partnersRateLimitPerSec } });
      const sync = app.app.get(CarrierSyncService);
      const outbox = app.app.get(OutboxService);

      const started = performance.now();
      const deadline = Date.now() + 120_000;
      const pending = () => app.orm.em.fork().count(OutboxEvent, { status: { $in: [OutboxStatus.PENDING, OutboxStatus.QUEUED] } });
      while (((await countInTransit(app)) > 0 || (await pending()) > 0) && Date.now() < deadline) {
        await sync.sweep();
        await outbox.relay();
        await sleep(300);
      }
      await waitForQueuesIdle(app.app, 30_000);
      const elapsed = Math.round(performance.now() - started);

      const runs = await syncRunTotals(app);
      const stats = await partners.stats();
      const toktok = await partners.toktok();
      const duplicateKeys = Object.values(toktok.byKey).filter((n) => n > 1).length;
      const em = app.orm.em.fork();
      const outboxTotal = await em.count(OutboxEvent);
      const sent = await em.count(OutboxEvent, { status: OutboxStatus.SENT });
      const remaining = await countInTransit(app);
      const maxDelivered = await maxDeliveredPerTerminal(app);
      console.log(
        `[실험 0005/${variant.name}] N=${N} limiter=${variant.bungaeRatePerSec}/s 워커별 실행=${JSON.stringify(runs.byWorker)} ` +
          `결과=${JSON.stringify(runs.byOutcome)} 시도최대=${runs.maxAttempt} 조회=${stats.calls['bungae.track']} 429=${stats.status429} ` +
          `전역동시최대=${stats.maxInFlightTotal} 같은운송장겹침=${stats.overlaps} 같은운송장동시최대=${stats.maxInFlight} ` +
          `DELIVERED단말기당최대=${maxDelivered} outbox=${outboxTotal} SENT=${sent} 톡톡수신=${toktok.total} 중복수신키=${duplicateKeys} ` +
          `남은배송중=${remaining} 소요=${elapsed}ms`,
      );

      expect(Object.keys(runs.byWorker).sort()).toEqual(['w1', 'w2']); // 두 워커가 실제로 나눠 처리했다
      // 같은 운송장 겹침 0은 운이 아니라 jobId(track-<shipmentId>) 중복 제거의 결과다. 그 장치가 깨지지 않았는지 본다.
      expect(stats.overlaps).toBe(0);
      expect(maxDelivered).toBe(1);
      expect(duplicateKeys).toBe(0);
      expect(sent).toBe(outboxTotal);
      expect(remaining).toBe(0);
    }, 240_000);
  });
}
