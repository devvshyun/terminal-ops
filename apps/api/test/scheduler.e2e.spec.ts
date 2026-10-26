import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUE, type QueueName } from '../src/queue/queue-names.js';
import { nextCronRun } from '../src/config/env-cron.js';
import { env } from '../src/config/env.js';
import { clearJobSchedulers, JOB_SCHEDULERS, SCHEDULE_TZ } from '../src/scheduler/job-schedulers.js';
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
    // 기대하는 다음 시각은 env 값(개발자 .env가 바꿨을 수 있다)과 시간대로 계산한다. 기본값의 시각(02:00 KST = 17:00 UTC)은 unit/env-cron이 본다
    const before = new Date();
    await new SchedulerService(queueOf(QUEUE.CARRIER_SWEEP), queueOf(QUEUE.OUTBOX), queueOf(QUEUE.DEVICE), queueOf(QUEUE.REPORT)).onApplicationBootstrap();
    const queues = [...new Set(JOB_SCHEDULERS.map((s) => s.queue))];
    for (const name of queues) {
      expect(await queueOf(name).getJobSchedulersCount()).toBe(JOB_SCHEDULERS.filter((s) => s.queue === name).length);
    }
    // cron 작업(report 큐)은 시간대와 함께 저장되고, 등록할 때 바로 돌지 않는다(다음 시각의 delayed job 하나씩, decisions/0035)
    const anomaly = await queueOf(QUEUE.REPORT).getJobScheduler('anomaly-scan-daily');
    expect(anomaly).toMatchObject({ pattern: env.anomalyScanCron, tz: SCHEDULE_TZ });
    expect(anomaly!.next).toBe(nextCronRun(env.anomalyScanCron, before).getTime());
    expect(anomaly!.next).toBeGreaterThan(Date.now());
    const van = await queueOf(QUEUE.REPORT).getJobScheduler('van-reconcile-daily');
    expect(van).toMatchObject({ pattern: env.vanReconcileCron, tz: SCHEDULE_TZ });
    expect(van!.next).toBe(nextCronRun(env.vanReconcileCron, before).getTime());
    expect(await queueOf(QUEUE.REPORT).getJobCounts('waiting', 'delayed')).toEqual({ waiting: 0, delayed: 2 });

    expect(await clearJobSchedulers(queueOf)).toEqual(JOB_SCHEDULERS.map((s) => s.id));
    for (const name of queues) {
      expect(await queueOf(name).getJobSchedulersCount()).toBe(0);
      expect(await queueOf(name).getJobCountByTypes('delayed')).toBe(0);
    }
    // 등록 때 바로 넣어진 첫 job(waiting)은 남아 있을 수 있다. 그것이 처리된 뒤에도 다음 주기 job(delayed)이 생기지 않아야
    // 큐가 빈다. scheduler가 남아 있으면 delayed job이 계속 있어 이 대기가 시간 초과로 실패한다.
    await waitForQueuesIdle(t.app, 5_000);
    expect(await clearJobSchedulers(queueOf)).toEqual([]);
  });
});
