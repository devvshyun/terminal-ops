import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisLock } from '../src/redis/redis-lock.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { ScanLock } from '../src/scan/scan-lock.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

describe('공용 Redis 연결과 RedisLock (decisions/0026)', () => {
  let t: TestApp;
  let redis: Redis;
  let lock: RedisLock;

  beforeAll(async () => {
    t = await createTestApp();
    redis = t.app.get<Redis>(REDIS);
    lock = t.app.get(RedisLock);
  });
  afterAll(async () => {
    await deleteTestKeys(redis);
    await t.app.close();
  });

  it('잡은 동안은 다시 못 잡고, 남의 토큰으로는 못 풀고, 내 토큰으로 풀면 다시 잡힌다', async () => {
    const key = lock.keyOf('test-lock', 'A');
    const token = await lock.acquire(key, 5000);
    expect(token).toEqual(expect.any(String));
    expect(await lock.acquire(key, 5000)).toBeNull();
    expect(await lock.release(key, 'not-mine')).toBe(false);
    expect(await redis.get(key)).toBe(token);
    expect(await lock.release(key, token!)).toBe(true);
    expect(await redis.exists(key)).toBe(0);
    expect(await lock.acquire(key, 5000)).not.toBeNull();
  });

  it('TTL이 지나면 저절로 풀린다', async () => {
    const key = lock.keyOf('test-lock', 'B');
    expect(await lock.acquire(key, 50)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 120));
    expect(await lock.acquire(key, 50)).not.toBeNull();
  });

  it('스캔 잠금도 공용 연결에 같은 키 형식(<접두사>:scan-lock:<scanId>)으로 잡는다', async () => {
    const scanLock = t.app.get(ScanLock);
    const token = await scanLock.acquire('BOX-REDIS-0001', 5000);
    expect(scanLock.keyOf('BOX-REDIS-0001')).toMatch(/^test-.+:scan-lock:BOX-REDIS-0001$/);
    expect(await redis.get(scanLock.keyOf('BOX-REDIS-0001'))).toBe(token);
    await scanLock.release('BOX-REDIS-0001', token!);
    expect(await redis.exists(scanLock.keyOf('BOX-REDIS-0001'))).toBe(0);
  });

  it('공용 연결에는 error 리스너가 있고, 앱을 닫으면 연결도 닫힌다', async () => {
    const other = await createTestApp();
    const conn = other.app.get<Redis>(REDIS);
    expect(conn).not.toBe(redis); // 앱마다 하나
    expect(conn.listenerCount('error')).toBeGreaterThanOrEqual(1);
    expect(await conn.ping()).toBe('PONG');
    // quit()은 서버 응답(OK)에서 끝나고, 소켓이 닫히면 'end'가 온다. 닫는 훅이 없으면 여기서 시간 초과로 실패한다.
    const ended = new Promise((r) => conn.once('end', r));
    await other.app.close();
    await ended;
    expect(conn.status).toBe('end');
  });
});
