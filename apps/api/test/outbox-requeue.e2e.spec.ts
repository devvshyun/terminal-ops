import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { OUTBOX_TYPE, OutboxEvent, OutboxStatus } from '../src/outbox/outbox-event.entity.js';
import { idempotencyKeyOf, OutboxService } from '../src/outbox/outbox.service.js';
import { QUEUE } from '../src/queue/queue-names.js';
import { resetQueues } from './helpers/queues.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

/**
 * QUEUED outbox 복구(Day 4 이월, decisions/0042). 워커 없는 앱이라 넣은 job은 waiting에 그대로 남는다 —
 * job을 지워 "Redis에서 job이 사라진 QUEUED 행"을 만든다.
 */
describe('QUEUED outbox 복구 (decisions/0042)', () => {
  let t: TestApp;
  let outbox: OutboxService;
  let queue: Queue;
  const em = () => t.orm.em.fork();
  /** 만든 시각을 정해 행을 넣는다(datetime(0)이라 초 단위) */
  async function insertRows(n: number, fields: Partial<Pick<OutboxEvent, 'status' | 'createdAt'>> = {}): Promise<number[]> {
    const e = em();
    const rows = Array.from({ length: n }, (_, i) =>
      e.create(OutboxEvent, { type: OUTBOX_TYPE.TERMINAL_STATUS_CHANGED, payload: { serialNo: `RQ-${i}`, fromStatus: 'IN_STOCK', toStatus: 'ALLOCATED', actor: 'kim', reason: 'r' }, ...fields }),
    );
    await e.flush();
    return rows.map((r) => r.id);
  }
  /** 데이터베이스 시각 반올림(datetime(0))을 넘도록 몇 초 뒤를 "지금"으로 */
  const later = () => new Date(Date.now() + 5_000);

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    outbox = t.app.get(OutboxService);
    queue = t.app.get<Queue>(getQueueToken(QUEUE.OUTBOX));
  });
  beforeEach(async () => {
    await resetQueues(t.app);
    await em().nativeDelete(OutboxEvent, {});
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await t.app.close();
  });

  it('notify job이 사라진 QUEUED 행만 같은 jobId로 다시 넣는다. 행은 QUEUED 그대로', async () => {
    const ids = await insertRows(3);
    expect((await outbox.relay()).queued).toEqual(ids);
    expect(await queue.getJobCounts('waiting')).toEqual({ waiting: 3 });
    await queue.remove(idempotencyKeyOf(ids[1])); // job 유실

    const result = await outbox.requeueStale({ staleMs: 0, now: later() });
    expect(result).toEqual({ checked: 3, requeued: [ids[1]] });
    expect(await queue.getJobCounts('waiting')).toEqual({ waiting: 3 });
    expect(await queue.getJobState(idempotencyKeyOf(ids[1]))).toBe('waiting');
    expect((await queue.getJob(idempotencyKeyOf(ids[1])))!.data).toEqual({ outboxId: ids[1] });
    expect((await em().find(OutboxEvent, {})).map((r) => r.status)).toEqual([OutboxStatus.QUEUED, OutboxStatus.QUEUED, OutboxStatus.QUEUED]);

    // 다시 불러도 job이 있으니 넣지 않는다
    expect(await outbox.requeueStale({ staleMs: 0, now: later() })).toEqual({ checked: 3, requeued: [] });
    expect(await queue.getJobCounts('waiting')).toEqual({ waiting: 3 });
  });

  it('만든 지 staleMs가 지나지 않은 QUEUED 행과 QUEUED가 아닌 행은 보지 않는다', async () => {
    const now = Date.now();
    const [old] = await insertRows(1, { status: OutboxStatus.QUEUED, createdAt: new Date(now - 120_000) });
    await insertRows(1, { status: OutboxStatus.QUEUED, createdAt: new Date(now) });
    await insertRows(1, { status: OutboxStatus.SENT, createdAt: new Date(now - 120_000) });
    await insertRows(1, { status: OutboxStatus.PENDING, createdAt: new Date(now - 120_000) });

    expect(await outbox.requeueStale({ staleMs: 60_000, now: new Date(now) })).toEqual({ checked: 1, requeued: [old] });
    expect(await queue.getJobCounts('waiting')).toEqual({ waiting: 1 });
  });
});
