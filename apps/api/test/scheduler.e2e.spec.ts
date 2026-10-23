import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUE, type QueueName } from '../src/queue/queue-names.js';
import { clearJobSchedulers } from '../src/scheduler/job-schedulers.js';
import { SchedulerService } from '../src/scheduler/scheduler.service.js';
import { resetQueues, waitForQueuesIdle } from './helpers/queues.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('주기 작업 삭제 (scheduler:clear, decisions/0015)', () => {
  let t: TestApp;
  const queueOf = (name: QueueName) => t.app.get<Queue>(getQueueToken(name));

  beforeAll(async () => {
    // 워커를 띄워 주기 job이 실제로 처리되게 한다(sweep·relay가 테스트 DB를 읽는다).
    t = await createTestApp({ workers: true });
    await resetDatabase(t.orm);
    await resetQueues(t.app);
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await t.app.close();
  });

  it('등록된 주기 작업을 지우면 다음 주기 job이 더 생기지 않는다. 다시 지우면 지울 것이 없다', async () => {
    // 테스트 앱에는 스케줄러가 없으므로(schedulers: false) 직접 등록한다. 접두사가 test-라 개발 Redis 키는 건드리지 않는다.
    await new SchedulerService(queueOf(QUEUE.CARRIER_SWEEP), queueOf(QUEUE.OUTBOX)).onApplicationBootstrap();
    expect(await queueOf(QUEUE.CARRIER_SWEEP).getJobSchedulersCount()).toBe(1);
    expect(await queueOf(QUEUE.OUTBOX).getJobSchedulersCount()).toBe(1);

    expect(await clearJobSchedulers(queueOf)).toEqual(['carrier-sweep', 'outbox-relay']);
    for (const name of [QUEUE.CARRIER_SWEEP, QUEUE.OUTBOX]) {
      expect(await queueOf(name).getJobSchedulersCount()).toBe(0);
      expect(await queueOf(name).getJobCountByTypes('delayed')).toBe(0);
    }
    // 등록 때 바로 넣어진 첫 job(waiting)은 남아 있을 수 있다. 그것이 처리된 뒤에도 다음 주기 job(delayed)이 생기지 않아야
    // 큐가 빈다. scheduler가 남아 있으면 delayed job이 계속 있어 이 대기가 시간 초과로 실패한다.
    await waitForQueuesIdle(t.app, 5_000);
    expect(await clearJobSchedulers(queueOf)).toEqual([]);
  });
});
