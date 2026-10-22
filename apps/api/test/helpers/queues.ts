import type { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { env } from '../../src/config/env.js';
import { ALL_QUEUES } from '../../src/queue/queue-names.js';

/** 조건이 참(또는 값)이 될 때까지 기다린다. 비동기 처리(큐 워커) 결과를 확인할 때 쓴다. */
export async function waitFor<T>(
  check: () => Promise<T | false | null | undefined>,
  { timeoutMs = 15_000, intervalMs = 100, message = '조건' }: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${message}을(를) ${timeoutMs}ms 안에 만족하지 못했습니다.`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function queuesOf(app: INestApplication): Queue[] {
  return ALL_QUEUES.map((name) => app.get<Queue>(getQueueToken(name)));
}

/**
 * 이 테스트 파일의 큐를 비운다. 접두사(env.queuePrefix)가 파일마다 달라 다른 파일·개발 서버의 job은 건드리지 않는다.
 * 안전장치: 테스트 접두사가 아니면 거절한다.
 */
export async function resetQueues(app: INestApplication): Promise<void> {
  if (!env.queuePrefix.startsWith('test-')) throw new Error(`테스트 접두사가 아닙니다: ${env.queuePrefix}`);
  for (const queue of queuesOf(app)) await queue.obliterate({ force: true });
}

/** 대기·처리 중·지연(재시도 대기) job이 모두 없어질 때까지 기다린다. */
export async function waitForQueuesIdle(app: INestApplication, timeoutMs = 15_000): Promise<void> {
  await waitFor(
    async () => {
      for (const queue of queuesOf(app)) {
        const c = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized', 'waiting-children');
        if (Object.values(c).some((n) => n > 0)) return false;
      }
      return true;
    },
    { timeoutMs, message: '큐가 빈 상태' },
  );
}
