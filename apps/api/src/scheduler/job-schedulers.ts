import type { Queue } from 'bullmq';
import { QUEUE, type QueueName } from '../queue/queue-names.js';

/** 주기 작업 목록. 등록(SchedulerService)과 삭제(scheduler:clear)가 같은 id를 쓴다. */
export const JOB_SCHEDULERS = [
  { queue: QUEUE.CARRIER_SWEEP, id: 'carrier-sweep', jobName: 'sweep' },
  { queue: QUEUE.OUTBOX, id: 'outbox-relay', jobName: 'relay' },
] as const satisfies readonly { queue: QueueName; id: string; jobName: string }[];

/**
 * 주기 작업을 Redis에서 지운다. job scheduler는 등록한 프로세스가 끝나도 Redis에 남아 계속 job을 만든다
 * (Day 2 리뷰 Minor 2, decisions/0015). 다음 주기 job(delayed)도 함께 지워진다.
 * @returns 지운 scheduler id 목록(없던 것은 빠진다)
 */
export async function clearJobSchedulers(queueOf: (name: QueueName) => Queue): Promise<string[]> {
  const removed: string[] = [];
  for (const s of JOB_SCHEDULERS) {
    if (await queueOf(s.queue).removeJobScheduler(s.id)) removed.push(s.id);
  }
  return removed;
}
