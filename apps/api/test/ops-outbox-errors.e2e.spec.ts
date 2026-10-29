import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OUTBOX_TYPE, OutboxEvent, OutboxStatus } from '../src/outbox/outbox-event.entity.js';
import { WeeklyReport, WeeklyReportStatus } from '../src/report/weekly-report.entity.js';
import { SyncRun } from '../src/shipment/shipment.entities.js';
import { VanReconciliationRun, VanRunStatus, VanRunTrigger } from '../src/van/van.entities.js';
import { resetQueues } from './helpers/queues.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const MONITOR = { 'X-Operator': 'mon', 'X-Test-Role': 'MONITOR' };
const ADMIN = { 'X-Operator': 'adm', 'X-Test-Role': 'ADMIN' };

/**
 * Outbox 요약과 최근 업무 오류(보강 6, decisions/0070·0042).
 * 워커 없는 앱이라 행을 직접 넣는다 — 만든 시각을 정해 두고 상태별 수·가장 오래된 행·오류 순서를 본다.
 */
describe('Outbox 요약 /ops/outbox, 최근 업무 오류 /ops/errors (보강 6)', () => {
  let t: TestApp;
  const em = () => t.orm.em.fork();
  const now = Date.now();
  /** 만든 시각을 정해 행을 넣는다(datetime(0) 열이 있어 초 단위로 맞춘다) */
  const minutesAgo = (m: number) => new Date(Math.floor((now - m * 60_000) / 1000) * 1000);
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await resetQueues(t.app);
    const e = em();
    const payload = { serialNo: 'OPS-1', fromStatus: 'IN_STOCK', toStatus: 'ALLOCATED', actor: 'kim', reason: 'r' };
    const row = (status: OutboxStatus, createdAt: Date, extra: Partial<OutboxEvent> = {}) =>
      e.create(OutboxEvent, { type: OUTBOX_TYPE.TERMINAL_STATUS_CHANGED, payload, status, createdAt, ...extra });
    row(OutboxStatus.PENDING, minutesAgo(9));
    row(OutboxStatus.PENDING, minutesAgo(1));
    const queuedOld = row(OutboxStatus.QUEUED, minutesAgo(5));
    row(OutboxStatus.QUEUED, minutesAgo(3));
    row(OutboxStatus.QUEUED, new Date(Math.floor(now / 1000) * 1000)); // 막 넣은 것 — 복구 sweep 기준(60초) 안
    row(OutboxStatus.SENT, minutesAgo(20));
    const failed = row(OutboxStatus.FAILED, minutesAgo(40), { attempts: 5, lastError: 'PartnerPermanentError: 톡톡메신저 400 INVALID_CHANNEL' });
    // 업무 오류 셋(시각을 다르게 두어 순서를 본다)과 오류가 아닌 행 하나씩
    const sync = e.create(SyncRun, { job: 'track-bungae', attempt: 3, worker: 'pid-1', outcome: 'ERROR', startedAt: minutesAgo(10), detail: 'PartnerTemporaryError: 번개택배 503' });
    e.create(SyncRun, { job: 'track-bungae', attempt: 1, worker: 'pid-1', outcome: 'OK', startedAt: minutesAgo(2) });
    const van = e.create(VanReconciliationRun, {
      status: VanRunStatus.FAILED,
      trigger: VanRunTrigger.SCHEDULED,
      requestedBy: 'system:van-reconcile',
      startedAt: minutesAgo(31),
      heartbeatAt: minutesAgo(30),
      finishedAt: minutesAgo(30),
      error: '수집 0건인데 운영 중 단말기가 3대입니다',
    });
    const weekly = e.create(WeeklyReport, { weekStart: '2026-10-19', status: WeeklyReportStatus.GENERATED, generatedAt: minutesAgo(20), attempts: 2, lastError: 'ToktokError: 톡톡메신저 503' });
    e.create(WeeklyReport, { weekStart: '2026-10-12', status: WeeklyReportStatus.SENT, generatedAt: minutesAgo(15), attempts: 1 });
    await e.flush();
    Object.assign(ids, { queuedOld: queuedOld.id, failed: failed.id, sync: sync.id, van: van.id, weekly: weekly.id });
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await t.app.close();
  });

  it('Outbox 요약: 상태별 수와 가장 오래된 PENDING·QUEUED 시각, 복구 sweep 기준', async () => {
    const res = await t.http(ADMIN).get('/ops/outbox');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      checkedAt: expect.stringMatching(/^\d{4}-/),
      counts: { PENDING: 2, QUEUED: 3, SENT: 1, FAILED: 1 },
      oldestPendingAt: minutesAgo(9).toISOString(),
      oldestQueuedAt: minutesAgo(5).toISOString(),
      requeueAfterMs: 60_000,
    });
  });

  it('최근 업무 오류: 수집 실패·VAN 대조 실패·주간 리포트 lastError·알림 실패를 시각 순으로 한 목록에(오류가 아닌 행은 빠진다)', async () => {
    const res = await t.http(MONITOR).get('/ops/errors');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { source: 'SYNC_RUN', id: ids.sync, at: minutesAgo(10).toISOString(), title: '택배 수집 실패 — track-bungae, 3번째 시도', message: 'PartnerTemporaryError: 번개택배 503' },
      { source: 'WEEKLY_REPORT', id: ids.weekly, at: minutesAgo(20).toISOString(), title: '주간 리포트 2026-10-19 주 보내기 실패 — GENERATED, 2번 시도', message: 'ToktokError: 톡톡메신저 503' },
      { source: 'VAN_RUN', id: ids.van, at: minutesAgo(30).toISOString(), title: `VAN 대조 #${ids.van} 실패 — 주기 실행`, message: '수집 0건인데 운영 중 단말기가 3대입니다' },
      {
        source: 'OUTBOX',
        id: ids.failed,
        at: minutesAgo(40).toISOString(),
        title: `알림 #${ids.failed} 보내기 실패 — terminal.status_changed, 5번 시도`,
        message: 'PartnerPermanentError: 톡톡메신저 400 INVALID_CHANNEL',
      },
    ]);
    expect((await t.http(ADMIN).get('/ops/errors').query({ limit: 2 })).body.map((e: { source: string }) => e.source)).toEqual(['SYNC_RUN', 'WEEKLY_REPORT']);
    expect((await t.http(MONITOR).get('/ops/errors').query({ limit: 0 })).status).toBe(400);
  });

  it('역할: 관제·ADMIN만 본다 — 운영자·현장 작업자 403, 로그인 없으면 401', async () => {
    for (const path of ['/ops/outbox', '/ops/errors']) {
      expect((await t.http({ 'X-Operator': 'op', 'X-Test-Role': 'OPERATOR' }).get(path)).status).toBe(403);
      expect((await t.http({ 'X-Operator': 'fld', 'X-Test-Role': 'FIELD' }).get(path)).status).toBe(403);
      expect((await t.http(null).get(path)).status).toBe(401);
    }
  });
});
