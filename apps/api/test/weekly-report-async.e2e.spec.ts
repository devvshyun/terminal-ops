import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { QUEUE } from '../src/queue/queue-names.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { kstWeekOf } from '../src/report/kst-week.js';
import { WeeklyReport, WeeklyReportStatus } from '../src/report/weekly-report.entity.js';
import { weeklyReportSendJobId } from '../src/report/weekly-report.service.js';
import { TerminalStatus as S } from '../src/terminal/terminal-status.js';
import { partners } from './helpers/partners.js';
import { resetQueues, waitFor } from './helpers/queues.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { insertTerminals } from './helpers/terminals.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'park' };

describe('주간 리포트 보내기 요청은 report 큐 job으로 (Day 5 최종 리뷰 Minor 6, decisions/0038)', () => {
  let t: TestApp;
  let reportQueue: Queue;
  const post = (weekStart: string) => t.http().post('/reports/weekly').set(OP).send({ weekStart });
  const get = (weekStart: string) => t.http().get(`/reports/weekly/${weekStart}`);
  /**
   * job이 끝나(queued false) 행이 원하는 상태가 되고 job이 지워질 때까지.
   * SENT인 주는 GET이 큐를 보지 않으므로(queued false 확정) 처리기가 SENT를 쓴 직후 job이 아직 active일 수 있다 — job이 사라질 때까지 기다린다(troubleshooting/0027)
   */
  const settled = (weekStart: string, done: (body: Record<string, unknown>) => boolean) =>
    waitFor(async () => {
      const res = await get(weekStart);
      if (res.body.queued !== false || !done(res.body)) return null;
      return (await reportQueue.getJob(weeklyReportSendJobId(weekStart))) ? null : res.body;
    }, { message: `${weekStart} 보내기 job 끝` });

  beforeAll(async () => {
    t = await createTestApp({ workers: true });
    await resetDatabase(t.orm);
    await resetQueues(t.app);
    reportQueue = t.app.get<Queue>(getQueueToken(QUEUE.REPORT));
    await insertTerminals(t, [{ serialNo: 'WA-01', status: S.IN_SERVICE, merchantCode: 'GANGNAM-KIMBAP' }]);
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await deleteTestKeys(t.app.get<Redis>(REDIS));
    await t.app.close();
  });

  it('POST는 행을 만들고 job을 넣어 바로 202 { queued: true }, 처리기가 보내면 GET이 SENT·queued false', async () => {
    const res = await post('2026-10-19');
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ weekStart: '2026-10-19', status: 'PENDING', alreadySent: false, queued: true, attempts: 0 });
    const body = await settled('2026-10-19', (b) => b.status === 'SENT');
    expect(body).toMatchObject({ status: 'SENT', attempts: 1, lastError: null, queuedAt: null, fileName: '단말온-주간리포트-2026-10-19.xlsx' });
    expect((await partners.toktok()).total).toBe(1);
    expect(await reportQueue.getJob(weeklyReportSendJobId('2026-10-19'))).toBeUndefined(); // 끝난 job은 지운다(다시 넣을 수 있게)
  });

  it('이미 보낸 주는 job 없이 200 { alreadySent: true }', async () => {
    const res = await post('2026-10-19');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'SENT', alreadySent: true, queued: false });
    expect(await reportQueue.getJobCounts('waiting', 'active', 'delayed')).toEqual({ waiting: 0, active: 0, delayed: 0 });
    expect((await partners.toktok()).total).toBe(0);
  });

  it('GET: 이미 보낸 주는 큐(Redis)를 보지 않고 queued false·queuedAt null', async () => {
    const getJob = vi.spyOn(reportQueue, 'getJob');
    try {
      const res = await get('2026-10-19');
      expect(res.body).toMatchObject({ status: 'SENT', queued: false, queuedAt: null });
      expect(getJob).not.toHaveBeenCalled();
    } finally {
      getJob.mockRestore();
    }
  });

  it('대기 중에 같은 주를 다시 눌러도 job은 하나(같은 jobId) — 메시지 한 번', async () => {
    await reportQueue.pause(); // 처리기가 가져가지 못하게 잠깐 멈춘다
    try {
      expect((await post('2026-10-12')).status).toBe(202);
      expect((await post('2026-10-12')).status).toBe(202);
      expect(await reportQueue.getJobCounts('waiting')).toEqual({ waiting: 1 });
      const waiting = (await get('2026-10-12')).body;
      expect(waiting).toMatchObject({ status: 'PENDING', queued: true, queuedAt: expect.any(String) });
      // queuedAt = job을 넣은 시각(job.timestamp). 화면이 "N분째 대기"를 보여 준다(워커가 없으면 waiting에 남는다)
      const job = await reportQueue.getJob(weeklyReportSendJobId('2026-10-12'));
      expect(waiting.queuedAt).toBe(new Date(job!.timestamp).toISOString());
    } finally {
      await reportQueue.resume();
    }
    expect(await settled('2026-10-12', (b) => b.status === 'SENT')).toMatchObject({ queuedAt: null });
    expect((await partners.toktok()).total).toBe(1);
  });

  it('보내기가 실패하면 job은 재시도 없이 끝나고 행에 lastError가 남는다. 다시 누르면 새 job으로 같은 파일을 보낸다', async () => {
    await partners.configure({ toktok: { failRate: 1 } });
    expect((await post('2026-10-05')).status).toBe(202);
    const failed = await settled('2026-10-05', (b) => b.lastError !== null);
    expect(failed).toMatchObject({ status: 'GENERATED', attempts: 1, queued: false });
    expect(failed.lastError).toMatch(/톡톡메신저 파일 응답 500/);

    await partners.configure({ toktok: { failRate: 0 } });
    expect((await post('2026-10-05')).status).toBe(202);
    const ok = await settled('2026-10-05', (b) => b.status === 'SENT');
    expect(ok).toMatchObject({ attempts: 2, lastError: null, generatedAt: failed.generatedAt });
  }, 30_000);

  it('입력 검증은 job을 넣기 전에: 월요일이 아니면 400, 끝나지 않은 주는 422(행도 만들지 않음)', async () => {
    expect((await post('2026-10-20')).body.code).toBe('INVALID_WEEK_START');
    const thisWeek = kstWeekOf(new Date()).weekStart;
    const res = await post(thisWeek);
    expect([res.status, res.body.code]).toEqual([422, 'WEEK_NOT_ENDED']);
    expect(await t.orm.em.fork().findOne(WeeklyReport, { weekStart: thisWeek })).toBeNull();
    expect(await reportQueue.getJobCounts('waiting', 'active')).toEqual({ waiting: 0, active: 0 });
    expect((await t.orm.em.fork().find(WeeklyReport, {}, { orderBy: { weekStart: 'asc' } })).map((r) => [r.weekStart, r.status])).toEqual([
      ['2026-10-05', WeeklyReportStatus.SENT],
      ['2026-10-12', WeeklyReportStatus.SENT],
      ['2026-10-19', WeeklyReportStatus.SENT],
    ]);
  });
});
