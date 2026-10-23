import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import type { QueueName } from '../queue/queue-names.js';
import { clearJobSchedulers } from './job-schedulers.js';

// npm run scheduler:clear — 이 접두사(QUEUE_PREFIX, 기본 terminal-ops)의 주기 작업을 지운다.
// 모든 프로세스를 RUN_SCHEDULERS=0으로 띄우고 싶을 때, 먼저 이것으로 남아 있는 주기 작업을 없앤다.
const queues = new Map<QueueName, Queue>();
const queueOf = (name: QueueName) => {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: { host: env.redis.host, port: env.redis.port }, prefix: env.queuePrefix });
    queues.set(name, q);
  }
  return q;
};
try {
  const removed = await clearJobSchedulers(queueOf);
  console.log(`주기 작업 삭제(접두사 ${env.queuePrefix}): ${removed.join(', ') || '없음'}`);
} finally {
  await Promise.all([...queues.values()].map((q) => q.close()));
}
