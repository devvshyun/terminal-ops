import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Anomaly, AnomalyRule } from '../src/anomaly/anomaly.entity.js';
import { env } from '../src/config/env.js';
import { DeviceConnectivity } from '../src/device/device-connectivity.entity.js';
import { Firmware, FirmwareRollout, FirmwareRolloutTarget, RolloutStatus, TargetStatus } from '../src/firmware/firmware.entities.js';
import { parseKstWeekStart } from '../src/report/kst-week.js';
import { WeeklyReportQueries } from '../src/report/weekly-report.queries.js';
import { TerminalModel } from '../src/terminal/terminal-model.entity.js';
import { TerminalStatusHistory } from '../src/terminal/terminal-status-history.entity.js';
import { TerminalStatus as S, TransitionSource as T } from '../src/terminal/terminal-status.js';
import { VanReconciliationRun, VanRunStatus, VanRunTrigger } from '../src/van/van.entities.js';
import { insertTerminals } from './helpers/terminals.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

/** 2026-10-19(월) 주: [2026-10-18 15:00 UTC, 2026-10-25 15:00 UTC) */
const WEEK = parseKstWeekStart('2026-10-19')!;
const NOW = new Date('2026-10-26T00:00:00.000Z'); // 월요일 09:00 KST
const sec = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

describe('주간 리포트 데이터 — DB 집계와 KST 주 경계 (F11, decisions/0035)', () => {
  let t: TestApp;
  const em = () => t.orm.em.fork();

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    const ids = await insertTerminals(t, [
      { serialNo: 'WR-01', status: S.IN_SERVICE, merchantCode: 'GANGNAM-KIMBAP' },
      { serialNo: 'WR-02', status: S.IN_SERVICE, merchantCode: 'GANGNAM-KIMBAP' },
      { serialNo: 'WR-03', status: S.RETURNED, modelCode: 'SN-200' },
      { serialNo: 'WR-04', status: S.IN_STOCK, modelCode: 'SN-300' },
      { serialNo: 'WR-05', status: S.IN_SERVICE, merchantCode: 'GANGNAM-KIMBAP' },
    ]);
    const id = (s: string) => ids.get(s)!;
    // 이력 occurred_at은 datetime(초)이라 밀리초가 반올림된다 — 경계는 초 단위로 둔다
    const h = (serialNo: string, from: S | null, to: S, source: T, at: Date) => ({
      terminal: id(serialNo),
      fromStatus: from,
      toStatus: to,
      source,
      actor: 'test',
      reason: 'test',
      occurredAt: at,
    });
    await em().insertMany(TerminalStatusHistory, [
      h('WR-01', null, S.RECEIVED, T.IMPORT, sec(WEEK.from, -1)), // 주 시작 1초 전 — 빠짐
      h('WR-01', S.ALLOCATED, S.SHIPPED, T.SHIPMENT, WEEK.from), // 주 시작 — 들어감
      h('WR-02', null, S.RECEIVED, T.SCAN, sec(WEEK.to, -1)), // 주 끝 1초 전 — 들어감
      h('WR-03', S.RETURNING, S.RETURNED, T.SCAN, sec(WEEK.to, -60)),
      h('WR-04', S.ALLOCATED, S.SHIPPED, T.SHIPMENT, WEEK.to), // 다음 주 시작 — 빠짐
    ]);
    const a = (serialNo: string, rule: AnomalyRule, resolvedAt: Date | null) => ({
      terminalId: id(serialNo),
      rule,
      detectedAt: sec(NOW, -3600),
      lastSeenAt: NOW,
      resolvedAt,
      detail: {},
    });
    await em().insertMany(Anomaly, [
      a('WR-03', AnomalyRule.RETURN_STALLED, null),
      a('WR-05', AnomalyRule.OFFLINE_TOO_LONG, null),
      a('WR-01', AnomalyRule.IN_SERVICE_NO_MERCHANT, NOW), // 닫힘 — 빠짐
    ]);
    await em().insertMany(DeviceConnectivity, [
      { terminalId: id('WR-01'), online: true, lastSeenAt: sec(NOW, -30), firmwareVersion: '1.0.0', changedAt: NOW },
      { terminalId: id('WR-05'), online: true, lastSeenAt: sec(NOW, -86_400), firmwareVersion: '1.0.0', changedAt: NOW }, // 하루 전: 오프라인으로 센다
    ]);
    const model = await em().findOneOrFail(TerminalModel, { code: 'SN-100' });
    const e = em();
    const fw = e.create(Firmware, { model, version: '9.9.9', createdBy: 'test' });
    const r = (createdAt: Date, finishedAt: Date | null, status: RolloutStatus) =>
      e.create(FirmwareRollout, { firmware: fw, stages: [100], failureThreshold: 0.2, minSamples: 1, stageTimeoutMs: 1000, createdBy: 'test', createdAt, finishedAt, status });
    const inWeek = r(sec(WEEK.from, -86_400), sec(WEEK.from, 3600), RolloutStatus.COMPLETED); // 주 전에 시작해 주 안에 끝남 — 들어감
    r(sec(WEEK.from, -2 * 86_400), sec(WEEK.from, -86_400), RolloutStatus.ABORTED); // 주 전에 끝남 — 빠짐
    r(WEEK.to, null, RolloutStatus.RUNNING); // 다음 주 시작 — 빠짐
    const running = r(sec(WEEK.from, 7200), null, RolloutStatus.RUNNING); // 주 안에 시작해 아직 진행 — 들어감
    await e.flush();
    await em().insertMany(FirmwareRolloutTarget, [
      { rollout: inWeek.id, terminal: id('WR-01'), stage: 0, status: TargetStatus.SUCCEEDED, offeredAt: NOW },
      { rollout: inWeek.id, terminal: id('WR-02'), stage: 0, status: TargetStatus.SUCCEEDED, offeredAt: NOW },
      { rollout: inWeek.id, terminal: id('WR-05'), stage: 0, status: TargetStatus.FAILED, offeredAt: NOW },
    ]);
    expect(running.id).toBeGreaterThan(inWeek.id);
    const run = (status: VanRunStatus, confirmed: number) =>
      em().insert(VanReconciliationRun, {
        trigger: VanRunTrigger.SCHEDULED,
        requestedBy: 'system:van-reconcile',
        startedAt: NOW,
        heartbeatAt: NOW, // 계획 뒤 fix 커밋(c296b93)이 넣은 NOT NULL 열
        finishedAt: NOW,
        status,
        fetched: 10,
        candidates: confirmed,
        confirmed,
        resolved: 0,
        counts: { NOT_REGISTERED: confirmed },
      });
    await run(VanRunStatus.COMPLETED, 1);
    await run(VanRunStatus.COMPLETED, 2); // 가장 최근 완료
    await run(VanRunStatus.FAILED, 9); // 실패한 실행은 빼고 본다
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('일곱 가지를 DB에서 집계하고 주 경계는 [KST 월 00:00, 다음 월 00:00)', async () => {
    const data = await t.app.get(WeeklyReportQueries).collect(WEEK, NOW);
    expect(data.week).toEqual({ weekStart: '2026-10-19', from: '2026-10-18T15:00:00.000Z', to: '2026-10-25T15:00:00.000Z' });
    expect(data.generatedAt).toBe(NOW.toISOString());
    expect(data.statusByModel).toEqual([
      { modelCode: 'SN-100', status: 'IN_SERVICE', count: 3 },
      { modelCode: 'SN-200', status: 'RETURNED', count: 1 },
      { modelCode: 'SN-300', status: 'IN_STOCK', count: 1 },
    ]);
    // ORDER BY enum 열은 글자 순서가 아니라 enum 선언 순서다(source: … SHIPMENT, SCAN …, rule: RETURN_STALLED가 OFFLINE_TOO_LONG보다 앞)
    expect(data.transitions).toEqual([
      { source: 'SHIPMENT', toStatus: 'SHIPPED', count: 1 },
      { source: 'SCAN', toStatus: 'RECEIVED', count: 1 },
      { source: 'SCAN', toStatus: 'RETURNED', count: 1 },
    ]);
    expect(data.flows).toEqual([
      { modelCode: 'SN-100', received: 1, shipped: 1, returned: 0 },
      { modelCode: 'SN-200', received: 0, shipped: 0, returned: 1 },
    ]);
    expect(data.anomalies.total).toBe(2);
    expect(data.anomalies.byRule).toEqual([
      { rule: 'RETURN_STALLED', open: 1 },
      { rule: 'OFFLINE_TOO_LONG', open: 1 },
    ]);
    expect(data.anomalies.items.map((i) => [i.serialNo, i.status, i.rule])).toEqual([
      ['WR-03', 'RETURNED', 'RETURN_STALLED'],
      ['WR-05', 'IN_SERVICE', 'OFFLINE_TOO_LONG'],
    ]);
    expect(data.connectivity).toEqual({ inService: 3, online: 1, offline: 1, noRecord: 1 });
    expect(data.rollouts.map((r) => [r.version, r.status, r.targets, r.succeeded, r.failed, r.timedOut])).toEqual([
      ['9.9.9', 'COMPLETED', 3, 2, 1, 0],
      ['9.9.9', 'RUNNING', 0, 0, 0, 0],
    ]);
    expect(data.van).toMatchObject({ confirmed: 2, fetched: 10, counts: { NOT_REGISTERED: 2 }, unverifiable: 0, acknowledgeDrop: false });
  });

  it('리뷰 반영: 온라인은 lastSeen > now − 기준(조회 API connectivity.service와 같은 부등호) — 정확히 기준만큼 지났으면 오프라인', async () => {
    const lastSeen = sec(NOW, -30); // WR-01
    const q = t.app.get(WeeklyReportQueries);
    expect((await q.collect(WEEK, new Date(lastSeen.getTime() + env.hbOfflineAfterMs - 1))).connectivity.online).toBe(1);
    expect((await q.collect(WEEK, new Date(lastSeen.getTime() + env.hbOfflineAfterMs))).connectivity).toEqual({ inService: 3, online: 0, offline: 2, noRecord: 1 });
  });
});
