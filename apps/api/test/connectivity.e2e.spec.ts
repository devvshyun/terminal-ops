import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { ActiveSetService } from '../src/device/active-set.service.js';
import { ConnectivityService } from '../src/device/connectivity.service.js';
import { DeviceConnectivity } from '../src/device/device-connectivity.entity.js';
import { deviceKeys } from '../src/device/device-keys.js';
import { OutboxEvent } from '../src/outbox/outbox-event.entity.js';
import { RedisLock } from '../src/redis/redis-lock.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { TerminalModel } from '../src/terminal/terminal-model.entity.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { captureQueries } from './helpers/query-log.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { prepareInService } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const AFTER = 90_000; // 오프라인 기준(ms)
const BULK = 50; // 묶음 이벤트 기준(CONNECTIVITY_BULK_EVENT_THRESHOLD 기본값)

describe('접속 상태 — 오프라인 판정·스냅샷·조회 (F8, decisions/0029)', () => {
  let t: TestApp;
  let redis: Redis;
  let conn: ConnectivityService;
  const k = () => deviceKeys();
  const em = () => t.orm.em.fork();
  const idOf = async (serialNo: string) => (await em().findOneOrFail(Terminal, { serialNo })).id;
  const rowOf = async (serialNo: string) => em().findOne(DeviceConnectivity, { terminalId: await idOf(serialNo) });
  const events = (type: string) => em().find(OutboxEvent, { type }, { orderBy: { id: 'asc' } });
  const beat = (serialNo: string, firmwareVersion = '1.0.0') => t.http().post('/devices/heartbeats').send({ items: [{ serialNo, firmwareVersion }] });

  beforeAll(async () => {
    t = await createTestApp();
    redis = t.app.get<Redis>(REDIS);
    conn = t.app.get(ConnectivityService);
    await resetDatabase(t.orm);
    for (const s of ['CN-0001', 'CN-0002', 'CN-0003']) await prepareInService(t, s);
    await deleteTestKeys(redis, 'hb:');
    await t.app.get(ActiveSetService).rebuild();
  });
  beforeEach(async () => {
    await redis.del(k().lastSeen, k().firmware, k().offline, k().snapshotAt);
  });
  afterAll(async () => {
    await deleteTestKeys(redis);
    await t.app.close();
  });

  it('detect: 기준보다 오래된 운영 중 단말기만 오프라인으로, 바뀐 것만 MySQL(UPSERT)·Outbox(device.offline)에 쓴다', async () => {
    const now = Date.now();
    await redis.zadd(k().lastSeen, now - 120_000, 'CN-0001', now - 1_000, 'CN-0002');
    await redis.hset(k().firmware, { 'CN-0001': '1.0.0', 'CN-0002': '1.0.0' });

    expect(await conn.detect(now, AFTER)).toEqual({ offline: ['CN-0001'], online: [] });
    expect(await rowOf('CN-0001')).toMatchObject({ online: false, lastSeenAt: new Date(now - 120_000), firmwareVersion: '1.0.0', changedAt: new Date(now) });
    expect(await rowOf('CN-0002')).toBeNull();
    const offline = await events('device.offline');
    expect(offline.map((e) => e.payload.serialNo)).toEqual(['CN-0001']);
    expect(await redis.smembers(k().offline)).toEqual(['CN-0001']);

    // 다시 판정해도 이미 오프라인이라 아무것도 쓰지 않는다(쿼리 0)
    const log = captureQueries(t.orm);
    try {
      expect(await conn.detect(now + 1_000, AFTER)).toEqual({ offline: [], online: [] });
    } finally {
      log.stop();
    }
    expect(log.queries).toEqual([]);
    expect(await events('device.offline')).toHaveLength(1);
  });

  it('online 복귀: 오프라인으로 기록된 단말기의 하트비트가 다시 오면 다음 판정에서 온라인, device.online', async () => {
    const now = Date.now();
    await redis.zadd(k().lastSeen, now - 120_000, 'CN-0001');
    await conn.detect(now, AFTER);
    expect(await beat('CN-0001', '1.0.1').then((r) => r.body.accepted)).toBe(1);

    const back = await conn.detect(Date.now(), AFTER);
    expect(back).toEqual({ offline: [], online: ['CN-0001'] });
    expect(await rowOf('CN-0001')).toMatchObject({ online: true, firmwareVersion: '1.0.1' });
    expect((await events('device.online')).at(-1)?.payload.serialNo).toBe('CN-0001');
    expect(await redis.smembers(k().offline)).toEqual([]);
  });

  it('운영 중이 아닌 단말기의 오래된 기록은 알림 없이 지운다', async () => {
    const before = (await events('device.offline')).length;
    await redis.zadd(k().lastSeen, Date.now() - 120_000, 'CN-9999');
    await redis.hset(k().firmware, 'CN-9999', '1.0.0');
    expect(await conn.detect(Date.now(), AFTER)).toEqual({ offline: [], online: [] });
    expect(await redis.zscore(k().lastSeen, 'CN-9999')).toBeNull();
    expect(await redis.hget(k().firmware, 'CN-9999')).toBeNull();
    expect(await events('device.offline')).toHaveLength(before);
  });

  it('detect는 한 번에 하나만 돈다(다른 프로세스가 잠금을 쥐고 있으면 건너뜀)', async () => {
    const lock = t.app.get(RedisLock);
    const key = lock.keyOf('job-lock', 'hb-detect');
    const token = await lock.acquire(key, 5_000);
    try {
      expect(await conn.detect(Date.now(), AFTER)).toEqual({ offline: [], online: [], skipped: true });
    } finally {
      await lock.release(key, token!);
    }
  });

  it('snapshot: 지난 스냅샷 뒤 바뀐 lastSeen만 UPSERT 한 문장으로 쓰고, 이미 있는 행의 online은 건드리지 않는다', async () => {
    await em().nativeDelete(DeviceConnectivity, {});
    const id1 = await idOf('CN-0001');
    await em().insert(DeviceConnectivity, { terminalId: id1, online: false, lastSeenAt: new Date(0), changedAt: new Date(0) });
    await beat('CN-0001', '2.0.0');
    await beat('CN-0002', '1.0.0');

    const log = captureQueries(t.orm);
    let first;
    try {
      first = await conn.snapshot();
    } finally {
      log.stop();
    }
    console.log(`[스냅샷 쿼리] ${JSON.stringify(log.queries.map((q) => q.slice(0, 200)))}`);
    expect(first).toEqual({ written: 2 });
    expect(log.queries.filter((q) => /^insert/i.test(q))).toHaveLength(1);
    expect(log.queries.filter((q) => /^select/i.test(q))).toHaveLength(0);
    const scoreOf = async (s: string) => new Date(Number(await redis.zscore(k().lastSeen, s)));
    expect(await rowOf('CN-0001')).toMatchObject({ online: false, lastSeenAt: await scoreOf('CN-0001'), firmwareVersion: '2.0.0' });
    expect(await rowOf('CN-0002')).toMatchObject({ online: true, lastSeenAt: await scoreOf('CN-0002'), firmwareVersion: '1.0.0' });

    // 그 뒤로 하트비트가 없으면 쓸 것이 없다
    expect(await conn.snapshot()).toEqual({ written: 0 });
    await beat('CN-0003');
    expect(await conn.snapshot()).toEqual({ written: 1 });
  });

  it('GET /terminals/:serialNo/connectivity — Redis가 있으면 Redis, 없으면 MySQL 스냅샷, 둘 다 없으면 none, 없는 단말기 404', async () => {
    await beat('CN-0002', '1.2.3');
    const live = await t.http().get('/terminals/CN-0002/connectivity');
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ serialNo: 'CN-0002', source: 'redis', online: true, firmwareVersion: '1.2.3' });

    await em().nativeDelete(DeviceConnectivity, {});
    await em().insert(DeviceConnectivity, {
      terminalId: await idOf('CN-0003'),
      online: false,
      lastSeenAt: new Date('2026-10-23T00:00:00.123Z'),
      firmwareVersion: '0.9.0',
      changedAt: new Date('2026-10-23T00:01:00Z'),
    });
    expect((await t.http().get('/terminals/CN-0003/connectivity')).body).toEqual({
      serialNo: 'CN-0003',
      source: 'snapshot',
      online: false,
      lastSeenAt: '2026-10-23T00:00:00.123Z',
      firmwareVersion: '0.9.0',
    });
    expect((await t.http().get('/terminals/CN-0001/connectivity')).body).toMatchObject({ source: 'none', online: false, lastSeenAt: null });
    expect((await t.http().get('/terminals/NONE-0001/connectivity')).status).toBe(404);
  });
  it('운영에서 빠진 단말기(online=true 행)의 lastSeen이 오래되면 판정이 알림 없이 online=false로 바꾼다 → GET이 온라인이라 하지 않는다', async () => {
    const id = String(await idOf('CN-0002'));
    await em().nativeDelete(DeviceConnectivity, {});
    await beat('CN-0002');
    expect(await conn.snapshot()).toEqual({ written: 1 }); // 첫 스냅샷: online=true 행
    expect(await rowOf('CN-0002')).toMatchObject({ online: true });
    const offlineBefore = (await events('device.offline')).length;

    await redis.hdel(k().active, 'CN-0002'); // IN_SERVICE에서 나감(project job이 하는 일)
    try {
      const now = Date.now();
      await redis.zadd(k().lastSeen, now - 120_000, 'CN-0002');
      expect(await conn.detect(now, AFTER)).toEqual({ offline: [], online: [] });
      expect(await rowOf('CN-0002')).toMatchObject({ online: false, changedAt: new Date(now) });
      expect(await events('device.offline')).toHaveLength(offlineBefore); // 알림 없음
      expect(await redis.zscore(k().lastSeen, 'CN-0002')).toBeNull();
      expect((await t.http().get('/terminals/CN-0002/connectivity')).body).toMatchObject({ source: 'snapshot', online: false });
    } finally {
      await redis.hset(k().active, 'CN-0002', id);
    }
  });

  it('GET 스냅샷 대체값: 행이 online=true여도 lastSeenAt이 기준보다 오래되면 online=false(방어)', async () => {
    await em().nativeDelete(DeviceConnectivity, {});
    await em().insert(DeviceConnectivity, {
      terminalId: await idOf('CN-0003'),
      online: true,
      lastSeenAt: new Date(Date.now() - 10 * 60_000),
      changedAt: new Date(Date.now() - 20 * 60_000),
    });
    expect((await t.http().get('/terminals/CN-0003/connectivity')).body).toMatchObject({ source: 'snapshot', online: false });
    await em().nativeUpdate(DeviceConnectivity, { terminalId: await idOf('CN-0003') }, { lastSeenAt: new Date(Date.now() - 1_000) });
    expect((await t.http().get('/terminals/CN-0003/connectivity')).body).toMatchObject({ source: 'snapshot', online: true });
  });

  it('lastSeenAt은 뒤로 가지 않는다: 늦게 도착한 스냅샷의 더 오래된 값이 더 새 값을 덮지 않는다(GREATEST)', async () => {
    await em().nativeDelete(DeviceConnectivity, {});
    const newer = new Date(Date.now() - 1_000);
    const older = Date.now() - 5_000;
    await em().insert(DeviceConnectivity, { terminalId: await idOf('CN-0001'), online: true, lastSeenAt: newer, changedAt: newer });
    await redis.zadd(k().lastSeen, older, 'CN-0001');
    await redis.hset(k().firmware, 'CN-0001', '3.0.0');

    const log = captureQueries(t.orm);
    try {
      expect(await conn.snapshot()).toEqual({ written: 1 });
    } finally {
      log.stop();
    }
    const insert = log.formatted.find((q) => /^insert/i.test(q)) ?? '';
    console.log(`[GREATEST 쿼리] ${insert}`);
    expect(insert).toMatch(/`last_seen_at` = greatest\(`last_seen_at`, values\(`last_seen_at`\)\)/i);
    expect((await rowOf('CN-0001'))!.lastSeenAt).toEqual(newer);
    expect(await redis.get(k().snapshotAt)).toBe(String(older));
  });

  it('스냅샷에 펌웨어 버전이 없으면(null) 이미 있는 값을 지우지 않는다(COALESCE)', async () => {
    await em().nativeDelete(DeviceConnectivity, {});
    const before = new Date(Date.now() - 5_000);
    await em().insert(DeviceConnectivity, { terminalId: await idOf('CN-0002'), online: true, lastSeenAt: before, firmwareVersion: '2.0.0', changedAt: before });
    await redis.zadd(k().lastSeen, Date.now() - 1_000, 'CN-0002'); // firmware HASH에는 없음 → null
    expect(await conn.snapshot()).toEqual({ written: 1 });
    expect((await rowOf('CN-0002'))!.firmwareVersion).toBe('2.0.0');
  });

  describe('대량 변화는 묶음 이벤트 하나로 (relay 줄서기 방지)', () => {
    const many = Array.from({ length: 120 }, (_, i) => `BK-${String(i + 1).padStart(4, '0')}`);

    beforeAll(async () => {
      const e = em();
      const model = await e.findOneOrFail(TerminalModel, { code: 'SN-100' });
      await e.insertMany(
        Terminal,
        many.map((serialNo) => ({ serialNo, model: model.id, status: TerminalStatus.IN_SERVICE, version: 1, createdAt: new Date(), updatedAt: new Date() })),
      );
      await t.app.get(ActiveSetService).rebuild();
    });

    it(`기준(${BULK}대)을 넘으면 device.offline_bulk / device.online_bulk 한 행(count, 앞 100대, truncated)`, async () => {
      const offlineBefore = (await events('device.offline')).length;
      const now = Date.now();
      await redis.zadd(k().lastSeen, ...many.flatMap((s) => [now - 120_000, s]));

      const off = await conn.detect(now, AFTER);
      expect(off.offline).toHaveLength(120);
      const bulk = await events('device.offline_bulk');
      expect(bulk).toHaveLength(1);
      expect(bulk[0].payload).toMatchObject({ count: 120, truncated: true, detectedAt: new Date(now).toISOString() });
      expect(bulk[0].payload.serials).toEqual(many.slice(0, 100));
      expect(await events('device.offline')).toHaveLength(offlineBefore); // 단말기별 행은 없다
      // MySQL·Redis 상태는 단말기별로 그대로 맞춘다
      expect(await rowOf('BK-0120')).toMatchObject({ online: false });
      expect(await redis.scard(k().offline)).toBe(120);

      await redis.zadd(k().lastSeen, ...many.flatMap((s) => [now + 1_000, s]));
      const on = await conn.detect(now + 2_000, AFTER);
      expect(on.online).toHaveLength(120);
      const onBulk = await events('device.online_bulk');
      expect(onBulk).toHaveLength(1);
      expect(onBulk[0].payload).toMatchObject({ count: 120, truncated: true });
      expect(await rowOf('BK-0001')).toMatchObject({ online: true });
    });

    it(`기준(${BULK}대) 이하면 지금처럼 단말기마다 device.offline`, async () => {
      const bulkBefore = (await events('device.offline_bulk')).length;
      const offlineBefore = (await events('device.offline')).length;
      const now = Date.now();
      await redis.zadd(k().lastSeen, ...many.slice(0, BULK).flatMap((s) => [now - 120_000, s]));
      expect((await conn.detect(now, AFTER)).offline).toHaveLength(BULK);
      expect(await events('device.offline')).toHaveLength(offlineBefore + BULK);
      expect(await events('device.offline_bulk')).toHaveLength(bulkBefore);
    });
  });
});
