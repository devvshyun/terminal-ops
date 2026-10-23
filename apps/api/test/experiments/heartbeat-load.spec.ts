import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { ActiveSetService } from '../../src/device/active-set.service.js';
import { ConnectivityService } from '../../src/device/connectivity.service.js';
import { DeviceConnectivity } from '../../src/device/device-connectivity.entity.js';
import { deviceKeys } from '../../src/device/device-keys.js';
import { HeartbeatService } from '../../src/device/heartbeat.service.js';
import { OutboxEvent } from '../../src/outbox/outbox-event.entity.js';
import { REDIS } from '../../src/redis/redis.provider.js';
import { seedInService } from '../helpers/device-fleet.js';
import { startDeviceSim, type DeviceSim, type DeviceSimLatency } from '../helpers/device-sim.js';
import { delta, mysqlCounters, redisCommandCalls, sum } from '../helpers/metrics.js';
import { captureQueries } from '../helpers/query-log.js';
import { deleteTestKeys } from '../helpers/redis-keys.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

// experiments/0008. 실행: EXPERIMENTS=1 npx vitest run test/experiments/heartbeat-load.spec.ts --silent=false
// 변형 하나만: EXP_VARIANTS=mysql-single … (데드락 수를 변형별로 나눠 재려면 변형마다 따로 실행한다)
// 최대 처리량(주어진 부하가 아니라 밀어붙이기): EXP_INTERVAL_MS=1000 EXP_DURATION_MS=20000 EXP_LOOSE=1
//   — 오류·건너뛴 주기를 단언하지 않고 적기만 한다
const N = Number(process.env.EXP_N ?? 5000);
const INTERVAL = Number(process.env.EXP_INTERVAL_MS ?? 5000);
const DURATION = Number(process.env.EXP_DURATION_MS ?? 30_000);
const CONCURRENCY = Number(process.env.EXP_CONCURRENCY ?? 16);
const SNAPSHOT_EVERY = Number(process.env.EXP_SNAPSHOT_MS ?? 10_000);
const OFFLINE_AFTER = Number(process.env.EXP_OFFLINE_AFTER_MS ?? INTERVAL * 3);
const DETECT_EVERY = Number(process.env.EXP_DETECT_MS ?? 1000);
const OFFLINE_RATE = Number(process.env.EXP_OFFLINE_RATE ?? 0.01);
const LOOSE = process.env.EXP_LOOSE === '1';
const VARIANTS = (process.env.EXP_VARIANTS ?? 'redis-batch,redis-single,mysql-batch,mysql-single,offline').split(',');
const LOAD = ['redis-batch', 'redis-single', 'mysql-batch', 'mysql-single'] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lat = (l: DeviceSimLatency) => `n=${l.count} p50=${l.p50.toFixed(1)} p95=${l.p95.toFixed(1)} max=${l.max.toFixed(1)}`;

describe(`실험 0008: 하트비트 ${N}대 — Redis 대 MySQL 직접 쓰기, 묶음 대 단건, 오프라인 판정`, () => {
  let t: TestApp;
  let redis: Redis;
  let sim: DeviceSim | undefined;
  let apiUrl: string;
  let heartbeats: HeartbeatService;
  let conn: ConnectivityService;

  async function clearState() {
    const k = deviceKeys();
    await redis.del(k.lastSeen, k.firmware, k.offline, k.snapshotAt);
    await t.orm.em.fork().nativeDelete(DeviceConnectivity, {});
  }

  beforeAll(async () => {
    t = await createTestApp();
    redis = t.app.get<Redis>(REDIS);
    heartbeats = t.app.get(HeartbeatService);
    conn = t.app.get(ConnectivityService);
    await resetDatabase(t.orm);
    await seedInService(t, 'HL', N);
    await deleteTestKeys(redis, 'hb:');
    expect(await t.app.get(ActiveSetService).rebuild()).toBe(N);
    await t.app.listen(0, '127.0.0.1');
    const server = t.app.getHttpServer();
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    sim = await startDeviceSim();
    console.log(`[실험 0008] API ${apiUrl} (keepAliveTimeout=${server.keepAliveTimeout}ms), device-sim PID ${sim.pid}`);
  }, 120_000);
  afterAll(async () => {
    if (heartbeats) heartbeats.writeMode = 'redis';
    await sim?.close();
    if (redis) await deleteTestKeys(redis);
    await t?.app.close();
  });

  for (const variant of LOAD) {
    it.runIf(VARIANTS.includes(variant))(`${variant}: ${DURATION / 1000}초 동안 주기 ${INTERVAL}ms`, async () => {
      const s0 = sim!;
      const [mode, shape] = variant.split('-') as ['redis' | 'mysql', 'batch' | 'single'];
      await clearState();
      heartbeats.writeMode = mode;
      await s0.reset();
      await s0.configure({ targetUrl: apiUrl, serialPrefix: 'HL', count: N, intervalMs: INTERVAL, batchSize: shape === 'batch' ? 100 : 1, concurrency: CONCURRENCY });

      const m0 = await mysqlCounters(t);
      const r0 = await redisCommandCalls(redis);
      const log = captureQueries(t.orm);
      const started = performance.now();
      let snapshots = 0;
      let snapshotErrors = 0;
      let pending: Promise<void> = Promise.resolve();
      const runSnapshot = () =>
        (pending = conn
          .snapshot()
          .then((r) => void (snapshots += r.skipped ? 0 : 1))
          .catch(() => void (snapshotErrors += 1)));
      const timer = mode === 'redis' ? setInterval(() => void runSnapshot(), SNAPSHOT_EVERY) : null;
      let seconds = 0;
      try {
        await s0.start();
        await sleep(DURATION);
        await s0.stop();
        seconds = (performance.now() - started) / 1000;
      } finally {
        if (timer) clearInterval(timer);
      }
      if (mode === 'redis') {
        await pending;
        await runSnapshot(); // 마지막 주기 뒤 남은 변화
      }
      log.stop();
      const m = delta(await mysqlCounters(t), m0);
      const r = delta(await redisCommandCalls(redis), r0);
      const s = await s0.stats();
      const writes = log.queries.filter((q) => /^(insert|update)/i.test(q)).length;
      const rowsInDb = await t.orm.em.fork().count(DeviceConnectivity, {});
      console.log(
        `[실험 0008/${variant}] N=${N} 주기=${INTERVAL}ms 동시=${CONCURRENCY} 시간=${seconds.toFixed(1)}s(stop 대기 포함) 주기수=${s.ticks} 건너뛴주기=${s.skippedTicks} ` +
          `요청=${s.requests} 하트비트=${s.heartbeatsSent} 받음=${s.heartbeatsAccepted} 처리량=${Math.round(s.heartbeatsAccepted / seconds)}/s ` +
          `오류=${s.errors}(http=${s.httpErrors} timeout=${s.timeouts} network=${s.networkErrors} bad=${s.badResponses})`,
      );
      console.log(`[실험 0008/${variant}] 응답시간ms 전체 ${lat(s.latency)} | 성공 ${lat(s.latencyOk)} | 실패 ${lat(s.latencyFailed)}`);
      console.log(
        `[실험 0008/${variant}] MySQL 앱쓰기문장=${writes} 스냅샷=${snapshots}회(실패 ${snapshotErrors}) device_connectivity행=${rowsInDb} 서버=${JSON.stringify(m)} | ` +
          `Redis 명령합=${sum(r)} ${JSON.stringify(r)}`,
      );

      expect(snapshotErrors).toBe(0);
      expect(rowsInDb).toBe(N);
      if (mode === 'redis') expect(await redis.zcard(deviceKeys().lastSeen)).toBe(N);
      else expect(await redis.zcard(deviceKeys().lastSeen)).toBe(0);
      if (!LOOSE) {
        expect(s.errors).toBe(0);
        expect(s.heartbeatsAccepted).toBe(s.heartbeatsSent);
      }
    }, DURATION + 120_000);
  }

  it.runIf(VARIANTS.includes('offline'))(`offline: 하트비트를 끊은 단말기(${OFFLINE_RATE * 100}%)가 오프라인으로 판정되기까지`, async () => {
    const s0 = sim!;
    await clearState();
    heartbeats.writeMode = 'redis';
    await s0.reset();
    await s0.configure({ targetUrl: apiUrl, serialPrefix: 'HL', count: N, intervalMs: INTERVAL, batchSize: 100, concurrency: CONCURRENCY });
    await s0.start();
    await sleep(INTERVAL * 2);
    expect((await conn.detect(Date.now(), OFFLINE_AFTER)).offline).toEqual([]);

    const silent = Math.round(N * OFFLINE_RATE);
    const cut = Date.now();
    await s0.configure({ offlineRate: OFFLINE_RATE }); // 이 순간부터 silent대가 보내지 않는다(시드로 고른 단말기)
    const configuredMs = Date.now() - cut;
    const detectedAt = new Map<string, number>();
    let online = 0;
    let rounds = 0;
    const deadline = cut + OFFLINE_AFTER + INTERVAL * 3;
    while (detectedAt.size < silent && Date.now() < deadline) {
      await sleep(DETECT_EVERY);
      const r = await conn.detect(Date.now(), OFFLINE_AFTER);
      rounds += 1;
      for (const serial of r.offline) detectedAt.set(serial, Date.now() - cut);
      online += r.online.length;
    }
    // 판정이 끝난 뒤 한 주기 더 돌려, 살아 있는 단말기가 잘못 오프라인이 되지 않는지 본다
    await sleep(INTERVAL);
    const after = await conn.detect(Date.now(), OFFLINE_AFTER);
    await s0.stop();
    const s = await s0.stats();
    const times = [...detectedAt.values()].sort((a, b) => a - b);
    const events = await t.orm.em.fork().count(OutboxEvent, { type: 'device.offline' });
    const bulk = await t.orm.em.fork().count(OutboxEvent, { type: 'device.offline_bulk' });
    console.log(
      `[실험 0008/offline] N=${N} 주기=${INTERVAL}ms 끊은단말기=${silent} 기준=${OFFLINE_AFTER}ms 판정주기=${DETECT_EVERY}ms 설정반영=${configuredMs}ms 판정횟수=${rounds} ` +
        `판정됨=${detectedAt.size} 첫판정=${times[0]}ms 중앙=${times[Math.floor(times.length / 2)]}ms 마지막판정=${times.at(-1)}ms (끊은 시각부터) 온라인복귀=${online} ` +
        `추가오프라인=${after.offline.length} device.offline이벤트=${events} 묶음이벤트=${bulk} 시뮬레이터오류=${s.errors} 건너뛴주기=${s.skippedTicks}`,
    );
    expect(detectedAt.size).toBe(silent);
    expect(online).toBe(0);
    expect(after.offline).toEqual([]);
    expect(times[0]).toBeGreaterThanOrEqual(OFFLINE_AFTER - INTERVAL);
  }, OFFLINE_AFTER + INTERVAL * 8 + 60_000);
});
