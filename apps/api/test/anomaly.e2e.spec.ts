import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { UniqueConstraintViolationException } from '@mikro-orm/mysql';
import { Anomaly, AnomalyRule as R } from '../src/anomaly/anomaly.entity.js';
import { AnomalyService } from '../src/anomaly/anomaly.service.js';
import { DAY_MS } from '../src/config/env-number.js';
import { DeviceConnectivity } from '../src/device/device-connectivity.entity.js';
import { RedisLock } from '../src/redis/redis-lock.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatus as S } from '../src/terminal/terminal-status.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { insertTerminals } from './helpers/terminals.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'lee' };
/** 기준 시각(고정). 규칙의 경과일은 이 시각에서 센다 */
const NOW = new Date('2026-10-26T00:00:00.000Z');
const daysAgo = (d: number, from = NOW) => new Date(from.getTime() - d * DAY_MS);

describe('이상 단말기 찾기 (F4, decisions/0034)', () => {
  let t: TestApp;
  let svc: AnomalyService;
  let ids: Map<string, number>;
  const em = () => t.orm.em.fork();
  const openRows = () => em().find(Anomaly, { resolvedAt: null }, { orderBy: { terminalId: 'asc', rule: 'asc' } });
  const serialOf = (terminalId: number) => [...ids].find(([, id]) => id === terminalId)![0];

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    svc = t.app.get(AnomalyService);
    ids = await insertTerminals(t, [
      { serialNo: 'AN-01', status: S.DELIVERED, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(8) }, // 배송 완료 8일
      { serialNo: 'AN-02', status: S.DELIVERED, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(6) }, // 6일 — 아님
      { serialNo: 'AN-03', status: S.RETURN_REQUESTED, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(15) },
      { serialNo: 'AN-04', status: S.RETURNING, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(15) },
      { serialNo: 'AN-05', status: S.RETURNING, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(13) }, // 13일 — 아님
      { serialNo: 'AN-06', status: S.SHIPPED, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(11) },
      { serialNo: 'AN-07', status: S.ALLOCATED, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(4) },
      { serialNo: 'AN-08', status: S.IN_SERVICE, merchantCode: null, statusChangedAt: daysAgo(1) }, // 가맹점 없음
      { serialNo: 'AN-09', status: S.IN_SERVICE, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(30) }, // 오프라인 4일
      { serialNo: 'AN-10', status: S.IN_SERVICE, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(30) }, // 오프라인 2일 — 아님
      { serialNo: 'AN-11', status: S.RETURNED, merchantCode: null, statusChangedAt: daysAgo(1) }, // 오프라인 10일이지만 운영 중 아님
      { serialNo: 'AN-12', status: S.IN_STOCK, statusChangedAt: daysAgo(100) }, // 재고는 규칙 없음
    ]);
    const conn = (serialNo: string, online: boolean, lastSeenDays: number) => ({
      terminalId: ids.get(serialNo)!,
      online,
      lastSeenAt: daysAgo(lastSeenDays),
      firmwareVersion: '1.0.0',
      changedAt: daysAgo(lastSeenDays),
    });
    await em().insertMany(DeviceConnectivity, [conn('AN-09', false, 4), conn('AN-10', false, 2), conn('AN-11', false, 10)]);
  });
  afterAll(async () => {
    await deleteTestKeys(t.app.get<Redis>(REDIS));
    await t.app.close();
  });

  it('여섯 규칙에 걸린 단말기를 찾아 열린 이상으로 남긴다(기준일 미만·운영 중 아님·재고는 아님)', async () => {
    const r = await svc.scan(NOW);
    expect(r).toMatchObject({ detected: 7, continuing: 0, resolved: 0 });
    expect(r.open).toEqual({
      [R.DELIVERED_NOT_INSTALLED]: 1,
      [R.RETURN_STALLED]: 2,
      [R.SHIPPED_TOO_LONG]: 1,
      [R.ALLOCATED_NO_SHIPMENT]: 1,
      [R.IN_SERVICE_NO_MERCHANT]: 1,
      [R.OFFLINE_TOO_LONG]: 1,
    });
    const rows = await openRows();
    expect(rows.map((a) => [serialOf(a.terminalId), a.rule])).toEqual([
      ['AN-01', R.DELIVERED_NOT_INSTALLED],
      ['AN-03', R.RETURN_STALLED],
      ['AN-04', R.RETURN_STALLED],
      ['AN-06', R.SHIPPED_TOO_LONG],
      ['AN-07', R.ALLOCATED_NO_SHIPMENT],
      ['AN-08', R.IN_SERVICE_NO_MERCHANT],
      ['AN-09', R.OFFLINE_TOO_LONG],
    ]);
    const an01 = rows[0];
    expect(an01.detectedAt.getTime()).toBe(NOW.getTime());
    expect(an01.lastSeenAt.getTime()).toBe(NOW.getTime());
    // 원시 SQL datetime을 UTC로 읽었는지(troubleshooting/0016): since가 정확히 8일 전
    expect(an01.detail).toEqual({ status: 'DELIVERED', since: daysAgo(8).toISOString(), days: 8 });
    expect(rows.at(-1)!.detail).toEqual({ lastSeenAt: daysAgo(4).toISOString(), days: 4 });
  });

  it('다시 찾으면 계속 걸린 것은 last_seen_at만, 풀린 것은 resolved_at, 다시 걸리면 새 행(닫힌 행과 겹쳐도 됨)', async () => {
    const later = new Date(NOW.getTime() + 3_600_000);
    expect(await svc.scan(later)).toMatchObject({ detected: 0, continuing: 7, resolved: 0 });
    expect((await openRows())[0].lastSeenAt.getTime()).toBe(later.getTime());

    // AN-01 설치됨 → 풀림
    await em().nativeUpdate(Terminal, { serialNo: 'AN-01' }, { status: S.IN_SERVICE, statusChangedAt: later });
    const evenLater = new Date(later.getTime() + 3_600_000);
    expect(await svc.scan(evenLater)).toMatchObject({ detected: 0, continuing: 6, resolved: 1 });
    const closed = await em().findOneOrFail(Anomaly, { terminalId: ids.get('AN-01')!, rule: R.DELIVERED_NOT_INSTALLED });
    expect(closed.resolvedAt?.getTime()).toBe(evenLater.getTime());

    // 다시 배송 완료 상태로 오래 → 같은 (단말기, 규칙)의 새 열린 행
    await em().nativeUpdate(Terminal, { serialNo: 'AN-01' }, { status: S.DELIVERED, statusChangedAt: daysAgo(9) });
    expect(await svc.scan(evenLater)).toMatchObject({ detected: 1, resolved: 0 });
    expect(await em().count(Anomaly, { terminalId: ids.get('AN-01')!, rule: R.DELIVERED_NOT_INSTALLED })).toBe(2);
  });

  it('열린 이상은 (단말기, 규칙)마다 하나뿐이다(부분 unique 함수 인덱스)', async () => {
    const row = { terminalId: ids.get('AN-03')!, rule: R.RETURN_STALLED, detectedAt: NOW, lastSeenAt: NOW, resolvedAt: null, detail: {} };
    await expect(em().insert(Anomaly, row)).rejects.toBeInstanceOf(UniqueConstraintViolationException);
    // 닫힌 행은 몇 개든 된다
    await em().insert(Anomaly, { ...row, resolvedAt: NOW });
    await em().insert(Anomaly, { ...row, resolvedAt: NOW });
  });

  it('GET /anomalies: 규칙·열림 조건과 afterId 페이지, 단말기 시리얼·지금 상태를 붙인다', async () => {
    const stalled = await t.http().get('/anomalies?rule=RETURN_STALLED&open=true');
    expect(stalled.status).toBe(200);
    expect(stalled.body.items.map((a: { serialNo: string; status: string }) => [a.serialNo, a.status])).toEqual([
      ['AN-03', 'RETURN_REQUESTED'],
      ['AN-04', 'RETURNING'],
    ]);
    expect(stalled.body.nextAfterId).toBeNull();
    const p1 = await t.http().get('/anomalies?open=true&limit=3');
    expect(p1.body.items).toHaveLength(3);
    const p2 = await t.http().get(`/anomalies?open=true&limit=3&afterId=${p1.body.nextAfterId}`);
    expect(p2.body.items[0].id).toBeGreaterThan(p1.body.nextAfterId);
    const closed = await t.http().get('/anomalies?open=false&rule=DELIVERED_NOT_INSTALLED');
    expect(closed.body.items[0]).toMatchObject({ serialNo: 'AN-01', resolvedAt: expect.any(String) });
    expect((await t.http().get('/anomalies?rule=NOPE')).status).toBe(400);
  });

  it('POST /anomaly-scans: 수동 찾기(지금 시각), 다른 찾기가 돌고 있으면 409 ANOMALY_SCAN_RUNNING', async () => {
    const res = await t.http().post('/anomaly-scans').set(OP);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ detected: expect.any(Number), continuing: expect.any(Number), resolved: expect.any(Number) });
    const lock = t.app.get(RedisLock);
    const key = lock.keyOf('job-lock', 'anomaly-scan');
    const token = await lock.acquire(key, 10_000);
    try {
      const busy = await t.http().post('/anomaly-scans').set(OP);
      expect(busy.status).toBe(409);
      expect(busy.body.code).toBe('ANOMALY_SCAN_RUNNING');
    } finally {
      await lock.release(key, token!);
    }
  });
});
