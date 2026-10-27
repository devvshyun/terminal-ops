import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OUTBOX_TYPE, OutboxEvent, OutboxStatus } from '../../src/outbox/outbox-event.entity.js';
import { OutboxService } from '../../src/outbox/outbox.service.js';
import { QUEUE } from '../../src/queue/queue-names.js';
import { sleep } from '../helpers/experiment.js';
import { partners } from '../helpers/partners.js';
import { resetQueues, waitFor } from '../helpers/queues.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';
import { killWorker, startWorker, stopWorker, WORKER_JS } from '../helpers/worker-process.js';

/**
 * 실험 0014: 알림(outbox) N건을 처리하는 워커 프로세스를 PID로 강제 종료(SIGKILL)하면 알림이 사라지는가(설계안 7장 "워커 강제 종료 → 알림 유실 0건").
 * A. 처리 중 강제 종료 → 새 워커: BullMQ stalled 검사가 죽은 워커의 active job을 되살리는지, 톡톡 수신 키별 횟수(유실·중복), 다 보내기까지 시간.
 *    죽인 직후 복구 sweep(requeueStale)을 한 번 불러 살아 있는 job을 다시 넣지 않는지도 본다.
 * B. job 유실(대기 job을 큐에서 지움 — stalled 한도 초과로 실패·삭제된 job, Redis 키 유실의 흉내) → 워커만으로는 0건 → 복구 sweep 뒤 모두 보내지는지.
 * 이 테스트 프로세스는 job을 넣기만 한다(workers: false). 처리는 dist/worker.js 자식 프로세스가 한다.
 * 재현: npm run build && EXPERIMENTS=1 npx vitest run test/experiments/worker-kill.spec.ts --silent=false
 * 바꾸기: EXP_N=300(알림 수), EXP_KILL_AT=0.3(SENT가 이 비율이 되면 죽임), EXP_TOKTOK_DELAY_MS=50(톡톡이 저장한 뒤 응답까지)
 */
const N = Number(process.env.EXP_N ?? 300);
const KILL_AT = Number(process.env.EXP_KILL_AT ?? 0.3);
const DELAY_MS = Number(process.env.EXP_TOKTOK_DELAY_MS ?? 50);

describe(`실험 0014 — 워커 강제 종료와 알림 (알림 ${N}건, 톡톡 응답 지연 ${DELAY_MS}ms)`, () => {
  let t: TestApp;
  let outbox: OutboxService;
  let queue: Queue;
  const workers: ChildProcess[] = [];
  const em = () => t.orm.em.fork();
  const sentCount = () => em().count(OutboxEvent, { status: OutboxStatus.SENT });

  /** 알림 N건을 PENDING으로 넣고 relay로 모두 QUEUED + notify job(waiting)으로 만든다 */
  async function prepare(prefix: string): Promise<void> {
    await em().nativeDelete(OutboxEvent, {});
    await resetQueues(t.app);
    await partners.reset();
    await partners.configure({ toktok: { delayMs: DELAY_MS } });
    const now = new Date();
    await em().insertMany(
      OutboxEvent,
      Array.from({ length: N }, (_, i) => ({
        type: OUTBOX_TYPE.TERMINAL_STATUS_CHANGED,
        payload: { serialNo: `${prefix}-${String(i).padStart(4, '0')}`, fromStatus: 'IN_STOCK', toStatus: 'ALLOCATED', actor: 'exp14', reason: '실험' },
        status: OutboxStatus.PENDING,
        attempts: 0,
        createdAt: now,
      })),
    );
    while ((await outbox.relay(1000)).queued.length > 0);
    expect(await queue.getJobCounts('waiting')).toEqual({ waiting: N });
  }

  /** 톡톡이 받은 것: 키 수(서로 다른 알림), 총 수신, 2번 이상 받은 키 수 */
  async function received() {
    const s = await partners.toktok();
    const counts = Object.values(s.byKey);
    return { keys: counts.length, total: s.total, duplicatedKeys: counts.filter((c) => c > 1).length, maxPerKey: Math.max(0, ...counts) };
  }

  beforeAll(async () => {
    if (!existsSync(WORKER_JS)) throw new Error('dist/worker.js가 없습니다. 먼저 npm run build 하세요.');
    t = await createTestApp({ workers: false });
    await resetDatabase(t.orm);
    outbox = t.app.get(OutboxService);
    queue = t.app.get<Queue>(getQueueToken(QUEUE.OUTBOX));
  }, 60_000);
  afterAll(async () => {
    for (const w of workers) await stopWorker(w);
    await partners.reset();
    if (t?.app) {
      await resetQueues(t.app);
      await t.app.close();
    }
  }, 60_000);

  it('A. 처리 중 강제 종료 → 새 워커: 유실 0, 중복은 죽을 때 처리 중이던 것만', async () => {
    await prepare('EXP14A');
    const w1 = await startWorker('w1', workers);
    const started = performance.now();
    await waitFor(async () => (await sentCount()) >= N * KILL_AT, { timeoutMs: 60_000, intervalMs: 10, message: `SENT ${N * KILL_AT}건` });
    const beforeKill = { sent: await sentCount(), counts: await queue.getJobCounts('waiting', 'active') };
    const killed = await killWorker(w1);
    const killedAt = performance.now();
    const afterKill = { sent: await sentCount(), counts: await queue.getJobCounts('waiting', 'active'), toktok: await received() };
    // 죽은 워커의 active job은 아직 큐에 있다(잠금이 풀리기 전) → 복구 sweep은 다시 넣지 않아야 한다
    const sweep = await outbox.requeueStale({ staleMs: 0, now: new Date(Date.now() + 5_000), limit: N });

    const w2 = await startWorker('w2', workers);
    // 대기 job이 다 끝난 시각(새 워커가 남은 대기분을 처리) → 죽은 워커의 active job이 stalled 검사로 돌아와 끝난 시각
    let waitingDoneAt = 0;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && (await sentCount()) < N) {
      if (!waitingDoneAt && (await queue.getJobCounts('waiting')).waiting === 0) waitingDoneAt = performance.now();
      await sleep(100);
    }
    const doneAt = performance.now();
    await stopWorker(w2);
    const rows = await em().find(OutboxEvent, {});
    const r = await received();
    const statuses = rows.reduce<Record<string, number>>((acc, row) => ((acc[row.status] = (acc[row.status] ?? 0) + 1), acc), {});
    const maxAttempts = Math.max(...rows.map((row) => row.attempts));
    console.log(
      `[실험 0014/A] N=${N} 죽인 결과=${JSON.stringify(killed)} 죽이기 직전 SENT=${beforeKill.sent} 큐=${JSON.stringify(beforeKill.counts)} ` +
        `죽인 뒤 SENT=${afterKill.sent} 큐=${JSON.stringify(afterKill.counts)} 그때 톡톡=${JSON.stringify(afterKill.toktok)} ` +
        `죽인 직후 sweep=${JSON.stringify({ checked: sweep.checked, requeued: sweep.requeued.length })} ` +
        `시작→죽임 ${Math.round(killedAt - started)}ms, 죽임→대기분 끝 ${Math.round(waitingDoneAt - killedAt)}ms, 죽임→모두 SENT ${Math.round(doneAt - killedAt)}ms ` +
        `행 상태=${JSON.stringify(statuses)} 시도 최대=${maxAttempts} 톡톡=${JSON.stringify(r)} 유실=${N - r.keys} 중복 수신=${r.total - r.keys}`,
    );
    expect(killed).toEqual({ code: null, signal: 'SIGKILL' });
    expect(sweep.requeued).toEqual([]);
    expect(statuses).toEqual({ SENT: N });
    expect(r.keys).toBe(N); // 유실 0
    expect(r.total - r.keys).toBeLessThanOrEqual(5); // 중복은 죽을 때 처리 중이던 것(워커 concurrency 5) 이하
  }, 300_000);

  it('B. job 유실(대기 job을 큐에서 지움) → 워커만으로는 안 보내짐 → 복구 sweep 뒤 모두, 중복 0', async () => {
    await prepare('EXP14B');
    await queue.drain(); // 대기 job N개를 지운다(행은 QUEUED 그대로)
    const lost = await queue.getJobCounts('waiting', 'active');
    const w3 = await startWorker('w3', workers);
    await sleep(3_000);
    const sentWithoutSweep = await sentCount();
    const started = performance.now();
    const sweep = await outbox.requeueStale({ staleMs: 0, now: new Date(Date.now() + 5_000), limit: N });
    await waitFor(async () => (await sentCount()) === N, { timeoutMs: 60_000, intervalMs: 50, message: '모두 SENT' });
    const elapsed = Math.round(performance.now() - started);
    await stopWorker(w3);
    const r = await received();
    console.log(
      `[실험 0014/B] N=${N} 지운 뒤 큐=${JSON.stringify(lost)} 3초 동안 SENT=${sentWithoutSweep} sweep=${JSON.stringify({ checked: sweep.checked, requeued: sweep.requeued.length })} ` +
        `sweep→모두 SENT ${elapsed}ms 톡톡=${JSON.stringify(r)} 유실=${N - r.keys} 중복 수신=${r.total - r.keys}`,
    );
    expect(lost).toEqual({ waiting: 0, active: 0 });
    expect(sentWithoutSweep).toBe(0);
    expect(sweep).toMatchObject({ checked: N });
    expect(sweep.requeued).toHaveLength(N);
    expect(r).toMatchObject({ keys: N, total: N });
  }, 120_000);
});
