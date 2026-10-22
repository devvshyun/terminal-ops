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
const N = Number(process.env.EXP_N ?? 30);
const WORKER_JS = resolve(process.cwd(), 'dist/worker.js');

/** dist/worker.js를 자식 프로세스로 띄우고 "worker ready"가 찍힐 때까지 기다린다. 테스트와 같은 큐 접두사·테스트 DB를 쓴다. */
async function startWorker(name: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [WORKER_JS], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', QUEUE_PREFIX: env.queuePrefix, WORKER_NAME: name, RUN_SCHEDULERS: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((ready, fail) => {
    const timer = setTimeout(() => fail(new Error(`${name}가 15초 안에 준비되지 않았습니다.`)), 15_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('worker ready')) {
        clearTimeout(timer);
        ready();
      }
    });
    child.once('exit', (code) => fail(new Error(`${name}가 종료됐습니다(exit ${code}).`)));
  });
  return child;
}

describe(`실험 0005: 워커 프로세스 2개가 같은 큐를 나눠 처리 (운송장 ${N}건)`, () => {
  let t: TestApp;
  const workers: ChildProcess[] = [];

  beforeAll(async () => {
    if (!existsSync(WORKER_JS)) throw new Error('dist/worker.js가 없습니다. 먼저 npm run build 하세요.');
    // 이 테스트 프로세스는 job을 넣기만 한다(workers: false). 처리는 자식 프로세스 2개가 한다.
    t = await createTestApp({ workers: false });
    await resetDatabase(t.orm);
    await resetQueues(t.app);
    await partners.reset();
    workers.push(await startWorker('w1'), await startWorker('w2'));
  }, 60_000);
  afterAll(async () => {
    for (const w of workers) {
      if (w.exitCode === null) {
        w.kill();
        await once(w, 'exit');
      }
    }
    await resetQueues(t.app);
    await t.app.close();
  });

  it('같은 운송장 동시 조회 0, DELIVERED 이력 중복 0, 톡톡 수신 중복 수를 잰다', async () => {
    await prepareMany(t, 'EXP5', N, 'BUNGAE');
    // 응답을 늦춰 두 워커가 겹칠 기회를 넓힌다.
    await partners.configure({ seed: 5, bungae: { delayMs: 100 } });
    const sync = t.app.get(CarrierSyncService);
    const outbox = t.app.get(OutboxService);

    const started = performance.now();
    const deadline = Date.now() + 120_000;
    const pending = () => t.orm.em.fork().count(OutboxEvent, { status: { $in: [OutboxStatus.PENDING, OutboxStatus.QUEUED] } });
    while (((await countInTransit(t)) > 0 || (await pending()) > 0) && Date.now() < deadline) {
      await sync.sweep();
      await outbox.relay();
      await sleep(300);
    }
    await waitForQueuesIdle(t.app, 30_000);
    const elapsed = Math.round(performance.now() - started);

    const runs = await syncRunTotals(t);
    const stats = await partners.stats();
    const toktok = await partners.toktok();
    const duplicateKeys = Object.values(toktok.byKey).filter((n) => n > 1).length;
    const em = t.orm.em.fork();
    const outboxTotal = await em.count(OutboxEvent);
    const sent = await em.count(OutboxEvent, { status: OutboxStatus.SENT });
    console.log(
      `[실험 0005] N=${N} 워커별 실행=${JSON.stringify(runs.byWorker)} 조회=${stats.calls['bungae.track']} ` +
        `같은운송장겹침=${stats.overlaps} 동시최대=${stats.maxInFlight} DELIVERED단말기당최대=${await maxDeliveredPerTerminal(t)} ` +
        `outbox=${outboxTotal} SENT=${sent} 톡톡수신=${toktok.total} 중복수신키=${duplicateKeys} 남은배송중=${await countInTransit(t)} 소요=${elapsed}ms`,
    );

    expect(Object.keys(runs.byWorker).sort()).toEqual(['w1', 'w2']); // 두 워커가 실제로 나눠 처리했다
    expect(stats.overlaps).toBe(0);
    expect(await maxDeliveredPerTerminal(t)).toBe(1);
    expect(sent).toBe(outboxTotal);
  }, 240_000);
});
