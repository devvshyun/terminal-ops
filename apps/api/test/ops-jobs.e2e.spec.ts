import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import { Worker, type Job, type Queue } from 'bullmq';
import { env } from '../src/config/env.js';
import { OpsActionLog } from '../src/ops/ops-action-log.entity.js';
import { QUEUE } from '../src/queue/queue-names.js';
import { resetQueues, waitFor } from './helpers/queues.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const MONITOR = { 'X-Operator': 'mon', 'X-Test-Role': 'MONITOR' };
const ADMIN = { 'X-Operator': 'adm', 'X-Test-Role': 'ADMIN' };
const OPERATOR = { 'X-Operator': 'op', 'X-Test-Role': 'OPERATOR' };

/**
 * 실패 job 보기·다시 시도·지우기와 감사 기록(보강 6, decisions/0072·0073).
 * 앱은 워커 없이 띄우고, 이 파일이 report 큐(test- 접두사)에 직접 워커를 붙여 실패를 실제로 만든다 — failNow가 true면 던진다.
 */
describe('실패 job과 관제 작업 /ops/queues/:name/failed·retry·remove, /ops/actions (보강 6)', () => {
  let t: TestApp;
  let queue: Queue;
  let worker: Worker;
  let failNow = true;
  let sendJob: Job;
  let vanJob: Job;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await resetQueues(t.app);
    queue = t.app.get<Queue>(getQueueToken(QUEUE.REPORT));
    worker = new Worker(
      QUEUE.REPORT,
      async (job) => {
        if (failNow) throw new Error(`톡톡메신저 503: ${job.name}`);
        return 'ok';
      },
      { connection: { host: env.redis.host, port: env.redis.port }, prefix: env.queuePrefix },
    );
    // 실패를 남기는 job 둘. 비밀처럼 보이는 이름의 값과 긴 글자를 data에 넣어 가리기를 본다
    sendJob = await queue.add(
      'weekly-report-send',
      { weekStart: '2026-10-19', apiToken: 'tok-123', note: '가'.repeat(150) },
      { attempts: 2, backoff: { type: 'fixed', delay: 10 }, removeOnFail: 100 },
    );
    await waitFor(async () => (await sendJob.getState()) === 'failed', { message: '보내기 job 실패' });
    vanJob = await queue.add('van-reconcile', { runId: 7 }, { jobId: 'van-run-7', attempts: 1, removeOnFail: 100 });
    await waitFor(async () => (await vanJob.getState()) === 'failed', { message: 'VAN job 실패' });
  });
  afterAll(async () => {
    await worker.close();
    await resetQueues(t.app);
    await t.app.close();
  });

  it('실패 job 목록: 최근 실패부터, 실패 이유·시도 수, data는 비밀처럼 보이는 이름을 가리고 긴 글자를 자른다', async () => {
    const res = await t.http(MONITOR).get(`/ops/queues/${QUEUE.REPORT}/failed`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, start: 0, limit: 20 });
    expect(res.body.items.map((j: { id: string }) => j.id)).toEqual(['van-run-7', sendJob.id]);
    expect(res.body.items[1]).toEqual({
      queue: 'report',
      id: sendJob.id,
      name: 'weekly-report-send',
      data: { weekStart: '2026-10-19', apiToken: '[가림]', note: `${'가'.repeat(100)}…(150자)` },
      failedReason: '톡톡메신저 503: weekly-report-send',
      attemptsMade: 2,
      maxAttempts: 2,
      createdAt: new Date(sendJob.timestamp).toISOString(),
      failedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(JSON.stringify(res.body)).not.toContain('tok-123');
    // 쪽 나누기(start·limit), ADMIN도 본다
    const second = await t.http(ADMIN).get(`/ops/queues/${QUEUE.REPORT}/failed`).query({ start: 1, limit: 1 });
    expect(second.body).toMatchObject({ total: 2, start: 1, limit: 1, items: [{ id: sendJob.id }] });
    // 실패가 없는 큐는 빈 목록, 없는 큐 이름은 404, limit 범위 밖은 400
    expect((await t.http(MONITOR).get(`/ops/queues/${QUEUE.DEVICE}/failed`)).body).toEqual({ items: [], total: 0, start: 0, limit: 20 });
    expect((await t.http(MONITOR).get('/ops/queues/no-such-queue/failed')).status).toBe(404);
    expect((await t.http(MONITOR).get(`/ops/queues/${QUEUE.REPORT}/failed`).query({ limit: 101 })).status).toBe(400);
  });

  it('다시 시도는 관제만: ADMIN·운영자 403. 관제가 하면 시도 수를 되돌려 다시 처리되고, 다시 하면 409 JOB_NOT_FAILED', async () => {
    expect((await t.http(ADMIN).post(`/ops/queues/${QUEUE.REPORT}/jobs/${sendJob.id}/retry`)).status).toBe(403);
    expect((await t.http(OPERATOR).post(`/ops/queues/${QUEUE.REPORT}/jobs/${sendJob.id}/retry`)).status).toBe(403);

    failNow = false;
    const res = await t.http(MONITOR).post(`/ops/queues/${QUEUE.REPORT}/jobs/${sendJob.id}/retry`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ queue: 'report', jobId: sendJob.id, action: 'RETRY_JOB', actionId: expect.any(Number) });
    await waitFor(async () => (await queue.getJobState(sendJob.id!)) === 'completed', { message: '다시 시도한 job 완료' });

    const again = await t.http(MONITOR).post(`/ops/queues/${QUEUE.REPORT}/jobs/${sendJob.id}/retry`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('JOB_NOT_FAILED');
    expect((await t.http(MONITOR).post(`/ops/queues/${QUEUE.REPORT}/jobs/no-such-job/retry`)).status).toBe(404);
    expect((await t.http(MONITOR).post(`/ops/queues/no-such-queue/jobs/${sendJob.id}/retry`)).status).toBe(404);
    expect((await t.http(MONITOR).get(`/ops/queues/${QUEUE.REPORT}/failed`)).body.total).toBe(1);
  });

  it('지우기도 관제만: 실패 job이 Redis에서 사라지고, 다시 지우면 404', async () => {
    expect((await t.http(ADMIN).post(`/ops/queues/${QUEUE.REPORT}/jobs/van-run-7/remove`)).status).toBe(403);
    const res = await t.http(MONITOR).post(`/ops/queues/${QUEUE.REPORT}/jobs/van-run-7/remove`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ jobId: 'van-run-7', action: 'REMOVE_JOB' });
    expect(await queue.getJob('van-run-7')).toBeUndefined();
    expect((await t.http(MONITOR).post(`/ops/queues/${QUEUE.REPORT}/jobs/van-run-7/remove`)).status).toBe(404);
    expect((await t.http(MONITOR).get(`/ops/queues/${QUEUE.REPORT}/failed`)).body).toMatchObject({ total: 0, items: [] });
  });

  it('감사 기록: 성공한 작업만 최근부터 — 누가(아이디·역할)·무엇을(큐·job·그때의 실패 이유). 403·404·409는 남지 않는다', async () => {
    const res = await t.http(ADMIN).get('/ops/actions');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toEqual({
      id: expect.any(Number),
      action: 'REMOVE_JOB',
      actor: 'mon',
      actorRole: 'MONITOR',
      queue: 'report',
      jobId: 'van-run-7',
      jobName: 'van-reconcile',
      detail: { failedReason: '톡톡메신저 503: van-reconcile', attemptsMade: 1, failedAt: expect.stringMatching(/^\d{4}-/) },
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(res.body.items[1]).toMatchObject({ action: 'RETRY_JOB', actor: 'mon', jobId: sendJob.id, jobName: 'weekly-report-send', detail: { attemptsMade: 2 } });
    const first = await t.http(MONITOR).get('/ops/actions').query({ limit: 1 });
    expect(first.body.nextBeforeId).toBe(first.body.items[0].id);
    expect((await t.http(MONITOR).get('/ops/actions').query({ beforeId: first.body.nextBeforeId })).body.items.map((a: { action: string }) => a.action)).toEqual(['RETRY_JOB']);
    expect(await t.orm.em.fork().count(OpsActionLog)).toBe(2);
    expect((await t.http(OPERATOR).get('/ops/actions')).status).toBe(403);
  });
});
