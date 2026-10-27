import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Anomaly, AnomalyRule } from '../src/anomaly/anomaly.entity.js';
import { Firmware, FirmwareRollout, FirmwareRolloutTarget, RolloutStatus, TargetStatus } from '../src/firmware/firmware.entities.js';
import { Shipment, SyncRun } from '../src/shipment/shipment.entities.js';
import { WeeklyReport, WeeklyReportStatus } from '../src/report/weekly-report.entity.js';
import { TerminalModel } from '../src/terminal/terminal-model.entity.js';
import { TerminalStatus as S } from '../src/terminal/terminal-status.js';
import { VanMismatchKind, VanReconciliationItem, VanReconciliationRun, VanRunStatus, VanRunTrigger } from '../src/van/van.entities.js';
import { captureQueries } from './helpers/query-log.js';
import { insertTerminals } from './helpers/terminals.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'han' };

/** 어드민 화면용 목록 API — 최근 것부터, beforeId 키셋 "더 보기"(decisions/0039) */
describe('어드민 목록 API (decisions/0039)', () => {
  let t: TestApp;
  const em = () => t.orm.em.fork();
  const get = (path: string, query: Record<string, string | number> = {}) => t.http().get(path).query(query);
  const ids = (body: { items: { id: number }[] }) => body.items.map((i) => i.id);

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('발주 목록: 최근 것부터 limit개와 nextBeforeId, 다음 쪽은 beforeId로. 상태로 거른다', async () => {
    const poNos: string[] = [];
    for (const quantity of [5, 6, 7]) {
      const res = await t.http().post('/purchase-orders').set(OP).send({ modelCode: 'SN-100', quantity });
      poNos.push(res.body.poNo);
    }
    const first = await get('/purchase-orders', { limit: 2 });
    expect(first.status).toBe(200);
    expect(first.body.items.map((p: { poNo: string }) => p.poNo)).toEqual([poNos[2], poNos[1]]);
    expect(first.body.items[0]).toMatchObject({ id: expect.any(Number), modelCode: 'SN-100', quantity: 7, status: 'ORDERED', orderedBy: 'han' });
    expect(first.body.nextBeforeId).toBe(first.body.items[1].id);
    const second = await get('/purchase-orders', { limit: 2, beforeId: first.body.nextBeforeId });
    expect(second.body.items.map((p: { poNo: string }) => p.poNo)).toEqual([poNos[0]]);
    expect(second.body.nextBeforeId).toBeNull();

    await t.http().post(`/purchase-orders/${poNos[0]}/close`).set(OP);
    expect((await get('/purchase-orders', { status: 'CLOSED' })).body.items.map((p: { poNo: string }) => p.poNo)).toEqual([poNos[0]]);
  });

  it('A/S 접수 목록: 최근 것부터, 상태·시리얼로 거른다', async () => {
    await insertTerminals(t, [
      { serialNo: 'LS-01', status: S.IN_SERVICE, merchantCode: 'GANGNAM-KIMBAP' },
      { serialNo: 'LS-02', status: S.IN_SERVICE, merchantCode: 'YEOKSAM-CAFE' },
    ]);
    const a = (await t.http().post('/service-tickets').set(OP).send({ serialNo: 'LS-01', symptom: '전원 꺼짐' })).body;
    const b = (await t.http().post('/service-tickets').set(OP).send({ serialNo: 'LS-02', symptom: '카드 인식 안 됨' })).body;
    await t.http().post(`/service-tickets/${a.id}/remote-checks`).set(OP).send({ resolved: true, note: '재부팅으로 해결' });

    const all = await get('/service-tickets');
    expect(ids(all.body)).toEqual([b.id, a.id]);
    expect(all.body.items[0]).toMatchObject({ serialNo: 'LS-02', merchantCode: 'YEOKSAM-CAFE', status: 'OPEN', symptom: '카드 인식 안 됨' });
    expect(ids((await get('/service-tickets', { status: 'OPEN' })).body)).toEqual([b.id]);
    expect(ids((await get('/service-tickets', { serialNo: 'LS-01' })).body)).toEqual([a.id]);
    expect((await get('/service-tickets', { status: 'NOPE' })).status).toBe(400);
  });

  it('펌웨어 배포 목록: 단계별 통계와 함께 최근 것부터, 상태로 거른다', async () => {
    const model = await em().findOneOrFail(TerminalModel, { code: 'SN-100' });
    const e = em();
    const fw1 = e.create(Firmware, { model, version: '9.0.1', createdBy: 'han' });
    const fw2 = e.create(Firmware, { model, version: '9.0.2', createdBy: 'han' });
    const r1 = e.create(FirmwareRollout, { firmware: fw1, stages: [10, 100], failureThreshold: 0.2, minSamples: 3, stageTimeoutMs: 60_000, createdBy: 'han', status: RolloutStatus.ABORTED });
    const r2 = e.create(FirmwareRollout, { firmware: fw2, stages: [50, 100], failureThreshold: 0.2, minSamples: 3, stageTimeoutMs: 60_000, createdBy: 'han' });
    await e.flush();
    const res = await get('/firmware-rollouts');
    expect(ids(res.body)).toEqual([r2.id, r1.id]);
    expect(res.body.items[0]).toMatchObject({ version: '9.0.2', modelCode: 'SN-100', status: 'RUNNING', stages: [50, 100] });
    expect(res.body.items[0].stageStats).toEqual([
      { stage: 0, percent: 50, targets: 0, offered: 0, succeeded: 0, failed: 0, timedOut: 0 },
      { stage: 1, percent: 100, targets: 0, offered: 0, succeeded: 0, failed: 0, timedOut: 0 },
    ]);
    expect(ids((await get('/firmware-rollouts', { status: 'ABORTED' })).body)).toEqual([r1.id]);
  });

  it('펌웨어 배포 목록의 단계 통계는 배포 수와 상관없이 쿼리 한 번(Day 6 최종 리뷰 Minor 10)', async () => {
    const model = await em().findOneOrFail(TerminalModel, { code: 'SN-100' });
    const serials = ['RO-01', 'RO-02', 'RO-03'];
    const terminalIds = await insertTerminals(t, serials.map((serialNo) => ({ serialNo, status: S.IN_SERVICE })));
    const e = em();
    const rollouts = ['9.1.1', '9.1.2', '9.1.3'].map((version) =>
      e.create(FirmwareRollout, { firmware: e.create(Firmware, { model, version, createdBy: 'han' }), stages: [50, 100], failureThreshold: 0.2, minSamples: 3, stageTimeoutMs: 60_000, createdBy: 'han', status: RolloutStatus.COMPLETED }),
    );
    await e.flush();
    // 첫 배포: 0단계 성공 1·실패 1, 1단계 제안 1 / 셋째 배포: 0단계 시간 초과 1 / 둘째는 대상 없음
    const target = (rollout: FirmwareRollout, serialNo: string, stage: number, status: TargetStatus) =>
      e.create(FirmwareRolloutTarget, { rollout, terminal: terminalIds.get(serialNo)!, stage, status } as never);
    target(rollouts[0], 'RO-01', 0, TargetStatus.SUCCEEDED);
    target(rollouts[0], 'RO-02', 0, TargetStatus.FAILED);
    target(rollouts[0], 'RO-03', 1, TargetStatus.OFFERED);
    target(rollouts[2], 'RO-01', 0, TargetStatus.TIMED_OUT);
    await e.flush();

    const log = captureQueries(t.orm);
    let res;
    try {
      res = await get('/firmware-rollouts', { status: 'COMPLETED' });
    } finally {
      log.stop();
    }
    expect(log.queries.filter((q) => /from `?firmware_rollout_target`?/i.test(q))).toHaveLength(1);
    const statsOf = (id: number) => res.body.items.find((i: { id: number }) => i.id === id).stageStats;
    expect(ids(res.body)).toEqual([rollouts[2].id, rollouts[1].id, rollouts[0].id]);
    expect(statsOf(rollouts[0].id)).toEqual([
      { stage: 0, percent: 50, targets: 2, offered: 0, succeeded: 1, failed: 1, timedOut: 0 },
      { stage: 1, percent: 100, targets: 1, offered: 1, succeeded: 0, failed: 0, timedOut: 0 },
    ]);
    expect(statsOf(rollouts[1].id)).toEqual([
      { stage: 0, percent: 50, targets: 0, offered: 0, succeeded: 0, failed: 0, timedOut: 0 },
      { stage: 1, percent: 100, targets: 0, offered: 0, succeeded: 0, failed: 0, timedOut: 0 },
    ]);
    expect(statsOf(rollouts[2].id)[0]).toEqual({ stage: 0, percent: 50, targets: 1, offered: 0, succeeded: 0, failed: 0, timedOut: 1 });
  });

  it('VAN 대조 실행 목록(최근 것부터)과 결과 항목의 종류 이름(kindLabel)', async () => {
    const e = em();
    const runs = [1, 2, 3].map((n) =>
      e.create(VanReconciliationRun, {
        trigger: VanRunTrigger.SCHEDULED,
        requestedBy: 'system:van-reconcile',
        startedAt: new Date(Date.UTC(2026, 9, n)),
        heartbeatAt: new Date(Date.UTC(2026, 9, n)),
        finishedAt: new Date(Date.UTC(2026, 9, n, 1)),
        status: VanRunStatus.COMPLETED,
      }),
    );
    await e.flush();
    e.create(VanReconciliationItem, { run: runs[2], serialNo: 'LS-01', kind: VanMismatchKind.MERCHANT_MISMATCH, ourValue: 'IN_SERVICE / A', vanValue: 'ACTIVE / B', verified: true });
    await e.flush();
    const first = await get('/van-reconciliations', { limit: 2 });
    expect(ids(first.body)).toEqual([runs[2].id, runs[1].id]);
    expect(first.body.items[0]).toMatchObject({ status: 'COMPLETED', trigger: 'SCHEDULED' });
    expect(ids((await get('/van-reconciliations', { limit: 2, beforeId: first.body.nextBeforeId })).body)).toEqual([runs[0].id]);
    const detail = await get(`/van-reconciliations/${runs[2].id}`);
    expect(detail.body.items).toEqual([expect.objectContaining({ serialNo: 'LS-01', kind: 'MERCHANT_MISMATCH', kindLabel: '가맹점 다름' })]);
  });

  it('이상 단말기 목록 항목에 규칙 이름(ruleLabel)이 있다', async () => {
    const [id] = (await insertTerminals(t, [{ serialNo: 'LS-AN', status: S.IN_SERVICE }])).values();
    await em().insert(Anomaly, { terminalId: id, rule: AnomalyRule.IN_SERVICE_NO_MERCHANT, detectedAt: new Date(), lastSeenAt: new Date(), detail: {} });
    const res = await get('/anomalies', { open: 'true' });
    expect(res.body.items).toEqual([expect.objectContaining({ serialNo: 'LS-AN', rule: 'IN_SERVICE_NO_MERCHANT', ruleLabel: '운영 중 가맹점 없음' })]);
  });

  it('이상 규칙 목록: 규칙 순서대로 이름과 기준일(가맹점 없음은 기준일 없음)', async () => {
    expect((await get('/anomaly-rules')).body).toEqual([
      { rule: 'DELIVERED_NOT_INSTALLED', label: '배송 완료 후 미설치', days: 7 },
      { rule: 'RETURN_STALLED', label: '회수 지연', days: 14 },
      { rule: 'SHIPPED_TOO_LONG', label: '배송 지연', days: 10 },
      { rule: 'ALLOCATED_NO_SHIPMENT', label: '배정 후 미출고', days: 3 },
      { rule: 'IN_SERVICE_NO_MERCHANT', label: '운영 중 가맹점 없음', days: null },
      { rule: 'OFFLINE_TOO_LONG', label: '장기 오프라인', days: 3 },
    ]);
  });

  it('주간 리포트 목록: 최근 주부터, before(주)로 다음 쪽. 파일은 싣지 않는다', async () => {
    const e = em();
    for (const weekStart of ['2026-09-28', '2026-10-05', '2026-10-12']) e.create(WeeklyReport, { weekStart, status: WeeklyReportStatus.SENT, fileName: `${weekStart}.xlsx`, fileSize: 10 });
    await e.flush();
    const first = await get('/reports/weekly', { limit: 2 });
    expect(first.status).toBe(200);
    expect(first.body.items.map((r: { weekStart: string }) => r.weekStart)).toEqual(['2026-10-12', '2026-10-05']);
    expect(first.body.items[0]).toMatchObject({ status: 'SENT', fileSize: 10, queued: false });
    expect(first.body.items[0]).not.toHaveProperty('file');
    expect(first.body.nextBefore).toBe('2026-10-05');
    const second = await get('/reports/weekly', { limit: 2, before: '2026-10-05' });
    expect(second.body).toMatchObject({ items: [expect.objectContaining({ weekStart: '2026-09-28' })], nextBefore: null });
    expect((await get('/reports/weekly', { before: '10/05' })).status).toBe(400);
  });

  it('주간 리포트 목록 before는 달력에 있는 날짜만(모양만 맞는 2026-13-45·2026-02-30은 400)', async () => {
    for (const before of ['2026-13-45', '2026-02-30', '2026-00-10']) {
      const res = await get('/reports/weekly', { before });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toContain('before');
    }
    expect((await get('/reports/weekly', { before: '2024-02-29' })).status).toBe(200); // 윤년
  });

  it('택배 수집 실행 이력: 최근 것부터, 큐·결과로 거르고 운송장 번호를 붙인다', async () => {
    const e = em();
    const [terminalId] = (await insertTerminals(t, [{ serialNo: 'LS-SH', status: S.SHIPPED }])).values();
    const shipment = e.create(Shipment, { terminal: terminalId, carrier: 'BUNGAE', trackingNo: 'BG-LS-1' } as never);
    await e.flush();
    const rows = [
      e.create(SyncRun, { job: 'track-bungae', shipment, attempt: 1, worker: 'w1', outcome: 'OK', fetched: 2, inserted: 2 }),
      e.create(SyncRun, { job: 'track-neurimbo', shipment: null, attempt: 1, worker: 'w1', outcome: 'ERROR', detail: '응답 500' }),
      e.create(SyncRun, { job: 'track-bungae', shipment, attempt: 2, worker: 'w2', outcome: 'DELIVERED', fetched: 3, inserted: 1, duplicated: 2 }),
    ];
    await e.flush();
    const all = await get('/sync-runs');
    expect(ids(all.body)).toEqual([rows[2].id, rows[1].id, rows[0].id]);
    expect(all.body.items[0]).toMatchObject({ job: 'track-bungae', trackingNo: 'BG-LS-1', attempt: 2, outcome: 'DELIVERED', duplicated: 2 });
    expect(all.body.items[1]).toMatchObject({ shipmentId: null, trackingNo: null, detail: '응답 500' });
    expect(ids((await get('/sync-runs', { job: 'track-bungae', outcome: 'OK' })).body)).toEqual([rows[0].id]);
  });

  it('택배 수집 실행 이력의 큐·결과 조건은 정해진 값만(오타는 빈 목록이 아니라 400)', async () => {
    for (const query of [{ job: 'track-bungea' }, { job: 'outbox' }, { outcome: 'ok' }, { outcome: 'FAILED' }] as Record<string, string>[]) {
      expect((await get('/sync-runs', query)).status).toBe(400);
    }
    for (const outcome of ['OK', 'DELIVERED', 'NOOP', 'SKIPPED', 'ERROR']) expect((await get('/sync-runs', { outcome })).status).toBe(200);
    for (const job of ['track-bungae', 'track-neurimbo']) expect((await get('/sync-runs', { job })).status).toBe(200);
  });

  it('페이지 조건 검증: limit 1~100, beforeId는 1 이상 안전한 정수', async () => {
    // beforeId 상한: 안전한 정수(2^53-1)를 넘으면 Number로 바꿀 때 값이 뭉개진다
    const bad: Record<string, string | number>[] = [{ limit: 0 }, { limit: 101 }, { beforeId: 'abc' }, { beforeId: 0 }, { beforeId: '9007199254740992' }, { beforeId: '1e20' }];
    for (const query of bad) {
      expect((await get('/sync-runs', query)).status).toBe(400);
      expect((await get('/purchase-orders', query)).status).toBe(400);
    }
    expect((await get('/sync-runs', { beforeId: String(Number.MAX_SAFE_INTEGER) })).status).toBe(200);
  });

  it('단말기 목록 page는 offset 계산이 안전한 정수 안에서, q는 시리얼 길이(32자)까지 (Day 6 최종 리뷰 Minor 11)', async () => {
    const maxPage = Math.floor(Number.MAX_SAFE_INTEGER / 100);
    for (const query of [{ page: '1e20' }, { page: String(maxPage + 1) }, { q: 'A'.repeat(33) }] as Record<string, string>[]) {
      const res = await get('/terminals', query);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toContain(Object.keys(query)[0]);
    }
    expect((await get('/terminals', { page: String(maxPage), size: 100 })).body).toMatchObject({ items: [], page: maxPage });
    expect((await get('/terminals', { q: 'A'.repeat(32) })).status).toBe(200);
  });
});
