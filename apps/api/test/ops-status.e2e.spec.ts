import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { OpsQueuesView } from '@terminal-ops/contracts';
import { env } from '../src/config/env.js';
import { ALL_QUEUES, QUEUE, type QueueName } from '../src/queue/queue-names.js';
import { JOB_SCHEDULERS } from '../src/scheduler/job-schedulers.js';
import { resetQueues, waitFor } from './helpers/queues.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const MONITOR = { 'X-Operator': 'mon', 'X-Test-Role': 'MONITOR' };
const ADMIN = { 'X-Operator': 'adm', 'X-Test-Role': 'ADMIN' };

/**
 * 운영 관제 읽기 — 큐 요약·주기 작업·프로세스 상태(보강 6, decisions/0070·0071).
 * 워커를 띄운 앱이라 이 파일의 큐(test- 접두사)를 실제로 처리한다. 주기 작업은 테스트 앱에 없으므로(schedulers: false) 직접 등록해 본다.
 */
describe('운영 관제 읽기 /ops/queues·/ops/schedulers·/ops/system (보강 6)', () => {
  let t: TestApp;
  const queueOf = (name: QueueName) => t.app.get<Queue>(getQueueToken(name));
  const view = (body: OpsQueuesView, name: QueueName) => body.queues.find((q) => q.name === name)!;

  beforeAll(async () => {
    t = await createTestApp({ workers: true });
    await resetDatabase(t.orm);
    await resetQueues(t.app);
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await t.app.close();
  });

  it('큐 요약: 여섯 큐가 정해진 순서로, 상태별 수·멈춤·가장 오래 기다린 job·워커 수', async () => {
    // carrier-sweep 큐를 멈추고 job 둘을 넣으면 워커가 있어도 waiting에 남는다(BullMQ 6은 멈춘 큐의 job도 waiting으로 센다)
    await queueOf(QUEUE.CARRIER_SWEEP).pause();
    const first = await queueOf(QUEUE.CARRIER_SWEEP).add('sweep', {}, { removeOnComplete: true });
    await new Promise((r) => setTimeout(r, 20));
    await queueOf(QUEUE.CARRIER_SWEEP).add('sweep', {}, { removeOnComplete: true });
    // report 큐에 1분 뒤 job(delayed)
    const delayed = await queueOf(QUEUE.REPORT).add('weekly-report', {}, { delay: 60_000, removeOnComplete: true });

    const res = await t.http(MONITOR).get('/ops/queues');
    expect(res.status).toBe(200);
    expect(res.body.recentMinutes).toBe(15);
    expect(res.body.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.body.queues.map((q: { name: string }) => q.name)).toEqual(ALL_QUEUES);
    expect(view(res.body, QUEUE.CARRIER_SWEEP)).toMatchObject({
      counts: { waiting: 2, active: 0, delayed: 0, prioritized: 0, failed: 0, completed: 0 },
      paused: true,
      oldestWaitingAt: new Date(first.timestamp).toISOString(),
    });
    expect(view(res.body, QUEUE.REPORT)).toMatchObject({ counts: { delayed: 1, waiting: 0 }, paused: false, oldestWaitingAt: null });
    // 워커를 띄운 앱이라 큐마다 워커 연결이 하나씩 있다
    for (const q of res.body.queues) expect(q.workers).toBeGreaterThanOrEqual(1);

    await delayed.remove();
    await queueOf(QUEUE.CARRIER_SWEEP).resume();
    await waitFor(async () => (await queueOf(QUEUE.CARRIER_SWEEP).getJobCounts('waiting', 'active')).waiting === 0, { message: 'sweep job 처리' });
  });

  it('최근 15분 처리량은 워커의 metrics로 센다 — 끝나서 지워진 job도 세고(removeOnComplete), 실패도 따로 센다', async () => {
    const before = (await t.http(MONITOR).get('/ops/queues')).body;
    // 앞 테스트의 sweep 2개가 끝났다(지워졌지만 metrics에 남는다)
    expect(view(before, QUEUE.CARRIER_SWEEP)).toMatchObject({ completedRecent: 2, counts: { completed: 0 } });
    // 한 번도 끝난 job이 없는 큐는 null
    expect(view(before, QUEUE.TRACK_BUNGAE)).toMatchObject({ completedRecent: null, failedRecent: null });

    // device 큐에 모르는 job → 프로세서가 UnrecoverableError로 실패(재시도 없음)
    await queueOf(QUEUE.DEVICE).add('no-such-job', {}, { removeOnFail: true });
    const after = await waitFor(
      async () => {
        const body = (await t.http(MONITOR).get('/ops/queues')).body;
        return view(body, QUEUE.DEVICE).failedRecent === 1 ? body : null;
      },
      { message: 'device 실패 metrics' },
    );
    expect(view(after, QUEUE.DEVICE)).toMatchObject({ completedRecent: null, failedRecent: 1, counts: { failed: 0 } });
  });

  it('주기 작업: 코드 목록이 모두 보이고, 등록된 것만 registered·다음 실행 시각. Redis에만 있는 것은 defined false로 뒤에', async () => {
    const none = await t.http(ADMIN).get('/ops/schedulers');
    expect(none.status).toBe(200);
    expect(none.body.map((s: { id: string }) => s.id)).toEqual(JOB_SCHEDULERS.map((s) => s.id));
    expect(none.body.every((s: { registered: boolean; nextRunAt: string | null }) => !s.registered && s.nextRunAt === null)).toBe(true);
    expect(none.body.find((s: { id: string }) => s.id === 'weekly-report')).toEqual({
      id: 'weekly-report',
      queue: 'report',
      jobName: 'weekly-report',
      every: null,
      pattern: env.weeklyReportCron,
      tz: 'Asia/Seoul',
      defined: true,
      registered: false,
      nextRunAt: null,
    });

    await queueOf(QUEUE.OUTBOX).upsertJobScheduler('outbox-relay', { every: 600_000 }, { name: 'relay', data: {} });
    await queueOf(QUEUE.DEVICE).upsertJobScheduler('old-renamed', { every: 600_000 }, { name: 'detect-offline', data: {} });
    const some = (await t.http(MONITOR).get('/ops/schedulers')).body;
    const relay = some.find((s: { id: string }) => s.id === 'outbox-relay');
    // 등록된 것은 Redis 값(여기서는 600000 — 코드 기본 2000이 아니라)을 보인다
    expect(relay).toMatchObject({ queue: 'outbox', every: 600_000, pattern: null, defined: true, registered: true });
    expect(Date.parse(relay.nextRunAt)).toBeGreaterThan(Date.now() - 5_000);
    expect(some.at(-1)).toMatchObject({ id: 'old-renamed', queue: 'device', jobName: 'detect-offline', every: 600_000, defined: false, registered: true });
    expect(some).toHaveLength(JOB_SCHEDULERS.length + 1);

    await queueOf(QUEUE.OUTBOX).removeJobScheduler('outbox-relay');
    await queueOf(QUEUE.DEVICE).removeJobScheduler('old-renamed');
  });

  it('프로세스 상태: MySQL·Redis 응답, api 실행 정보, 큐마다 워커(이름 = WORKER_NAME 또는 pid-<pid>)', async () => {
    const res = await t.http(MONITOR).get('/ops/system');
    expect(res.status).toBe(200);
    expect(res.body.mysql).toEqual({ ok: true, latencyMs: expect.any(Number), error: null });
    expect(res.body.redis).toEqual({ ok: true, latencyMs: expect.any(Number), error: null });
    expect(res.body.api).toEqual({
      version: 'dev',
      startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      node: process.version,
      queuePrefix: env.queuePrefix,
      runWorkers: env.runWorkers,
      runSchedulers: false,
    });
    expect(Date.parse(res.body.api.startedAt)).toBeLessThanOrEqual(Date.now());
    expect([...new Set(res.body.workers.map((w: { queue: string }) => w.queue))].sort()).toEqual([...ALL_QUEUES].sort());
    for (const w of res.body.workers) expect(w).toEqual({ queue: expect.any(String), name: env.workerName, idleSeconds: expect.any(Number) });
  });

  it('역할: 관제·ADMIN만 본다 — 운영자·현장 작업자 403, 로그인 없으면 401', async () => {
    for (const path of ['/ops/queues', '/ops/schedulers', '/ops/system']) {
      expect((await t.http(ADMIN).get(path)).status).toBe(200);
      const op = await t.http({ 'X-Operator': 'op', 'X-Test-Role': 'OPERATOR' }).get(path);
      expect(op.status).toBe(403);
      expect(op.body.code).toBe('FORBIDDEN');
      expect((await t.http({ 'X-Operator': 'fld', 'X-Test-Role': 'FIELD' }).get(path)).status).toBe(403);
      expect((await t.http(null).get(path)).status).toBe(401);
    }
  });
});
