import { describe, expect, it } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import type { EntityManager } from '@mikro-orm/mysql';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { OPS_REDIS_TIMEOUT_MS, OpsQueuesService } from '../../src/ops/ops-queues.service.js';
import { withTimeout } from '../../src/ops/with-timeout.js';

/**
 * Redis가 느리거나 죽었을 때 관제 읽기가 오래 매달리지 않는다(Task 1 리뷰 반영, decisions/0071).
 * BullMQ Queue 연결은 ioredis 기본값(maxRetriesPerRequest 20·오프라인 큐)이라 명령이 몇 분 기다릴 수 있다 —
 * 대답하지 않는 큐·Redis를 흉내 낸 가짜를 넣고 시간 제한 안에 503 또는 ok:false로 답하는지 본다.
 */
const never = () => new Promise<never>(() => {});
/** 어떤 메서드를 불러도 끝나지 않는 큐 */
const hangingQueue = () => new Proxy({}, { get: () => never }) as unknown as Queue;
const okEm = { getConnection: () => ({ execute: async () => [{ 1: 1 }] }) } as unknown as EntityManager;

function service(redis: { ping: () => Promise<unknown> }): OpsQueuesService {
  const q = Array.from({ length: 6 }, hangingQueue);
  const s = new OpsQueuesService(okEm, redis as unknown as Redis, q[0], q[1], q[2], q[3], q[4], q[5]);
  s.timeoutMs = 50;
  return s;
}

/** 걸린 시간(ms)과 결과 */
async function timed<T>(run: () => Promise<T>): Promise<{ ms: number; result: T | unknown }> {
  const started = performance.now();
  const result = await run().catch((error: unknown) => error);
  return { ms: performance.now() - started, result };
}

describe('관제 읽기의 Redis 시간 제한 (Task 1 리뷰 반영)', () => {
  it('기본 제한은 2초', () => {
    expect(OPS_REDIS_TIMEOUT_MS).toBe(2000);
  });

  it('withTimeout: 늦으면 제한 시각에 던지고, 제때 끝나면 그 값', async () => {
    await expect(withTimeout(never(), 20, 'probe')).rejects.toThrow('probe: 20ms 안에 답이 없습니다');
    await expect(withTimeout(Promise.resolve(7), 20, 'probe')).resolves.toBe(7);
  });

  it('큐 요약·주기 작업: 큐가 대답하지 않으면 제한 시간 안에 503', async () => {
    const s = service({ ping: async () => 'PONG' });
    const runs: (() => Promise<unknown>)[] = [() => s.summary(), () => s.schedulers()];
    for (const run of runs) {
      const { ms, result } = await timed(run);
      expect(result).toBeInstanceOf(ServiceUnavailableException);
      expect(ms).toBeLessThan(1000);
    }
  });

  it('프로세스 상태: Redis가 대답하지 않아도 답한다 — redis ok:false, 워커는 빈 목록, MySQL은 그대로', async () => {
    const { ms, result } = await timed(() => service({ ping: never }).system());
    expect(ms).toBeLessThan(1000);
    expect(result).toMatchObject({ mysql: { ok: true }, redis: { ok: false, latencyMs: null, error: 'TIMEOUT' }, workers: [] });
  });

  it('프로세스 상태의 오류 글은 이름·코드만 — 메시지에 든 호스트·포트를 보이지 않는다', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:6379'), { code: 'ECONNREFUSED' });
    const res = (await service({ ping: () => Promise.reject(refused) }).system()) as { redis: { ok: boolean; error: string } };
    expect(res.redis).toMatchObject({ ok: false, error: 'Error ECONNREFUSED' });
    expect(JSON.stringify(res)).not.toContain('10.1.2.3');
  });
});
