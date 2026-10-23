import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { ActiveSetService } from '../src/device/active-set.service.js';
import { deviceKeys } from '../src/device/device-keys.js';
import { RolloutService } from '../src/firmware/rollout.service.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { seedInService } from './helpers/device-fleet.js';
import { startDeviceSim, type DeviceSim } from './helpers/device-sim.js';
import { waitFor } from './helpers/queues.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'han' };

describe('단말기 시뮬레이터 ↔ API — 실제 프로세스 연동 (F8)', () => {
  let t: TestApp;
  let redis: Redis;
  let sim: DeviceSim;
  let apiUrl: string;

  beforeAll(async () => {
    t = await createTestApp();
    redis = t.app.get<Redis>(REDIS);
    await resetDatabase(t.orm);
    await seedInService(t, 'DS', 5);
    await deleteTestKeys(redis, 'hb:');
    await t.app.get(ActiveSetService).rebuild();
    await t.app.listen(0, '127.0.0.1');
    apiUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
    sim = await startDeviceSim();
  }, 60_000);
  afterAll(async () => {
    await sim?.close();
    await deleteTestKeys(redis);
    await t.app.close();
  });

  it('하트비트가 Redis에 남고, 100% 배포 제안을 시뮬레이터가 받아 성공을 보고하면 판단 job이 COMPLETED', async () => {
    await sim.configure({ targetUrl: apiUrl, serialPrefix: 'DS', count: 5, intervalMs: 200, batchSize: 5, updateDelayMs: 50, firmwareVersion: '1.0.0' });
    await sim.start();
    await waitFor(async () => (await redis.zcard(deviceKeys().lastSeen)) === 5, { message: '하트비트 5대' });

    await t.http().post('/firmware').set(OP).send({ modelCode: 'SN-100', version: '2.0.0' });
    const created = await t.http().post('/firmware-rollouts').set(OP).send({ modelCode: 'SN-100', version: '2.0.0', stages: [100], failureThreshold: 0.2, minSamples: 1 });
    expect(created.status).toBe(201);
    await waitFor(async () => (await sim.stats()).reportsSucceeded === 5, { message: '성공 보고 5건' });
    expect((await t.app.get(RolloutService).control(created.body.id)).action).toBe('COMPLETED');
    await waitFor(async () => Object.values(await redis.hgetall(deviceKeys().firmware)).every((v) => v === '2.0.0'), { message: '펌웨어 2.0.0' });
    expect((await sim.device('DS-0003')).firmwareVersion).toBe('2.0.0');

    await sim.stop();
    const stats = await sim.stats();
    console.log(`[device-sim 연동] ${JSON.stringify({ ...stats, latency: undefined })}`);
    expect(stats).toMatchObject({ errors: 0, heartbeatsRejected: 0, updateOffers: 5, reportsFailed: 0, reportErrors: 0 });
    expect(stats.heartbeatsAccepted).toBe(stats.heartbeatsSent);
  });
});
