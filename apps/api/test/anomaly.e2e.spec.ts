import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EntityManager as CoreEntityManager } from '@mikro-orm/core';
import type { Redis } from 'ioredis';
import { UniqueConstraintViolationException } from '@mikro-orm/mysql';
import { Anomaly, AnomalyRule as R } from '../src/anomaly/anomaly.entity.js';
import { AnomalyService, openRowsUpdateSql, type ScanResult } from '../src/anomaly/anomaly.service.js';
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
    expect(rows.at(-1)!.detail).toEqual({ lastSeenAt: daysAgo(4).toISOString(), since: daysAgo(4).toISOString(), days: 4 });
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
  const HOUR = 3_600_000;
  const G = 'GANGNAM-KIMBAP';
  const openOf = async (terminalIds: number[]) =>
    em().find(Anomaly, { terminalId: { $in: terminalIds }, resolvedAt: null }, { orderBy: { terminalId: 'asc', rule: 'asc' } });

  it('fix: 오프라인 규칙 — 하트비트가 한 번도 없으면 운영 시작(status_changed_at)으로, 있으면 online 값과 상관없이 마지막 하트비트로 본다', async () => {
    const at = new Date(NOW.getTime() + 6 * HOUR);
    const more = await insertTerminals(t, [
      { serialNo: 'AF-01', status: S.IN_SERVICE, merchantCode: G, statusChangedAt: daysAgo(5) }, // 하트비트 없음, 운영 5일 → 걸림
      { serialNo: 'AF-02', status: S.IN_SERVICE, merchantCode: G, statusChangedAt: daysAgo(2) }, // 하트비트 없음, 운영 2일 → 아님
      { serialNo: 'AF-03', status: S.IN_SERVICE, merchantCode: G, statusChangedAt: daysAgo(30) }, // online=1인데 마지막 하트비트 5일 전 → 걸림
      { serialNo: 'AF-04', status: S.IN_SERVICE, merchantCode: G, statusChangedAt: daysAgo(30) }, // online=1, 1일 전 → 아님
    ]);
    const conn = (serialNo: string, lastSeenDays: number) => ({
      terminalId: more.get(serialNo)!,
      online: true,
      lastSeenAt: daysAgo(lastSeenDays),
      firmwareVersion: '1.0.0',
      changedAt: daysAgo(30),
    });
    await em().insertMany(DeviceConnectivity, [conn('AF-03', 5), conn('AF-04', 1)]);
    await svc.scan(at);
    const rows = await openOf([...more.values()]);
    expect(rows.map((a) => [a.terminalId, a.rule, a.detail])).toEqual([
      [more.get('AF-01'), R.OFFLINE_TOO_LONG, { lastSeenAt: null, since: daysAgo(5).toISOString(), days: 5 }],
      [more.get('AF-03'), R.OFFLINE_TOO_LONG, { lastSeenAt: daysAgo(5).toISOString(), since: daysAgo(5).toISOString(), days: 5 }],
    ]);
  });

  it('fix 2: 마지막 하트비트가 오래됐어도 오늘 운영에 다시 들어온 단말기는 아니다. 기준은 greatest(마지막 하트비트, 운영 시작)', async () => {
    const at = new Date(NOW.getTime() + 9 * HOUR);
    const more = await insertTerminals(t, [
      // 회수 → 재설치: 하트비트는 10일 전(지난 운영 때)이지만 운영 시작은 1시간 전 → 아님
      { serialNo: 'AR-01', status: S.IN_SERVICE, merchantCode: G, statusChangedAt: new Date(at.getTime() - HOUR) },
      // 하트비트 10일 전, 운영 시작 5일 전 → 걸림. since·days는 운영 시작(둘 중 늦은 값)에서 센다
      { serialNo: 'AR-02', status: S.IN_SERVICE, merchantCode: G, statusChangedAt: daysAgo(5) },
    ]);
    const conn = (serialNo: string) => ({ terminalId: more.get(serialNo)!, online: false, lastSeenAt: daysAgo(10), firmwareVersion: '1.0.0', changedAt: daysAgo(10) });
    await em().insertMany(DeviceConnectivity, [conn('AR-01'), conn('AR-02')]);
    await svc.scan(at);
    expect((await openOf([...more.values()])).map((a) => [a.terminalId, a.rule, a.detail])).toEqual([
      [more.get('AR-02'), R.OFFLINE_TOO_LONG, { lastSeenAt: daysAgo(10).toISOString(), since: daysAgo(5).toISOString(), days: 5 }],
    ]);
  });

  it('fix: 기준일 경계 ±1시간 — 기준보다 1시간 전은 걸리고 1시간 뒤는 아니다(시간대가 어긋나면 둘 다 뒤집힌다, troubleshooting/0016)', async () => {
    const at = new Date(NOW.getTime() + 7 * HOUR);
    const more = await insertTerminals(t, [
      { serialNo: 'AB-01', status: S.DELIVERED, merchantCode: G, statusChangedAt: new Date(at.getTime() - 7 * DAY_MS - HOUR) },
      { serialNo: 'AB-02', status: S.DELIVERED, merchantCode: G, statusChangedAt: new Date(at.getTime() - 7 * DAY_MS + HOUR) },
    ]);
    await svc.scan(at);
    expect((await openOf([...more.values()])).map((a) => [a.terminalId, a.rule])).toEqual([[more.get('AB-01'), R.DELIVERED_NOT_INSTALLED]]);
  });

  it('fix: 찾기 두 번이 겹쳐도(잠금 만료) 500이 아니고, (단말기, 규칙)마다 열린 이상은 하나. 늦은 쪽은 새로 걸린 것으로 세지 않는다', async () => {
    const more = await insertTerminals(t, [
      { serialNo: 'AO-01', status: S.SHIPPED, merchantCode: G, statusChangedAt: daysAgo(20) },
      { serialNo: 'AO-02', status: S.ALLOCATED, merchantCode: G, statusChangedAt: daysAgo(10) },
    ]);
    const aoIds = [...more.values()];
    const t1 = new Date(NOW.getTime() + 8 * HOUR);
    const t2 = new Date(t1.getTime() + 1000);
    // 늦은 찾기(t2)가 열린 이상을 읽은 직후, 잠금이 만료돼 들어온 다른 찾기(t1)가 끝까지 돈다(잠금 없이 내부 찾기를 부름)
    const find = CoreEntityManager.prototype.find;
    let entered = false;
    let early: ScanResult | undefined;
    const spy = vi.spyOn(CoreEntityManager.prototype, 'find').mockImplementation(async function (this: CoreEntityManager, ...args: unknown[]) {
      const result = await (find as (...a: unknown[]) => Promise<unknown>).apply(this, args);
      if (!entered && args[0] === Anomaly) {
        entered = true;
        early = await (svc as unknown as { scanLocked: (now: Date) => Promise<ScanResult> }).scanLocked(t1);
      }
      return result;
    } as never);
    let late: ScanResult;
    try {
      late = await svc.scan(t2);
    } finally {
      spy.mockRestore();
    }
    expect(early!.newMatches.filter((m) => aoIds.includes(m.terminalId)).map((m) => m.serialNo)).toEqual(['AO-01', 'AO-02']);
    expect(late.newMatches.filter((m) => aoIds.includes(m.terminalId))).toEqual([]);
    const rows = await openOf(aoIds);
    expect(rows.map((a) => [a.terminalId, a.rule, a.detectedAt.getTime(), a.lastSeenAt.getTime()])).toEqual([
      [more.get('AO-01'), R.SHIPPED_TOO_LONG, t1.getTime(), t2.getTime()],
      [more.get('AO-02'), R.ALLOCATED_NO_SHIPMENT, t1.getTime(), t2.getTime()],
    ]);
  });
  it('fix 3: 겹친 찾기 중 늦게 쓰는 쪽의 시각이 더 이르면 last_seen_at을 뒤로 돌리지 않는다(INSERT 겹침·계속 갱신 둘 다)', async () => {
    const more = await insertTerminals(t, [{ serialNo: 'AL-01', status: S.SHIPPED, merchantCode: G, statusChangedAt: daysAgo(20) }]);
    const al = more.get('AL-01')!;
    const continuingId = ids.get('AN-03')!; // 앞 테스트부터 열려 있는 RETURN_STALLED
    const t1 = new Date(NOW.getTime() + 10 * HOUR); // 먼저 시작했지만 늦게 쓰는 찾기
    const t2 = new Date(t1.getTime() + 1000); // 나중에 시작했지만 먼저 끝나는 찾기
    const find = CoreEntityManager.prototype.find;
    let entered = false;
    const spy = vi.spyOn(CoreEntityManager.prototype, 'find').mockImplementation(async function (this: CoreEntityManager, ...args: unknown[]) {
      const result = await (find as (...a: unknown[]) => Promise<unknown>).apply(this, args);
      if (!entered && args[0] === Anomaly) {
        entered = true;
        await (svc as unknown as { scanLocked: (now: Date) => Promise<ScanResult> }).scanLocked(t2);
      }
      return result;
    } as never);
    try {
      await svc.scan(t1);
    } finally {
      spy.mockRestore();
    }
    const rows = await openOf([al, continuingId]);
    expect(rows.map((a) => [a.terminalId, a.detectedAt.getTime() <= t2.getTime(), a.lastSeenAt.getTime()])).toEqual([
      [continuingId, true, t2.getTime()],
      [al, true, t2.getTime()],
    ]);
  });

  it('fix: 열린 이상 PK 갱신은 resolved_at 조건이 있어도 PRIMARY 범위로 돈다(EXPLAIN UPDATE, troubleshooting/0014)', async () => {
    const ids = (await openRows()).slice(0, 3).map((a) => a.id);
    // 힌트가 없으면 통계에 따라 (resolved_at, rule) 보조 인덱스 범위를 고를 수 있다(빈 표에서 확인, decisions/0034)
    const [hinted] = await em().execute<{ key: string; type: string }[]>(`explain ${openRowsUpdateSql('last_seen_at', 3)}`, [NOW, ...ids]);
    expect(hinted).toMatchObject({ key: 'PRIMARY', type: 'range' });
  });
});
