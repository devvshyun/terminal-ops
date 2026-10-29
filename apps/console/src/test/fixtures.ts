import type { OpsOutboxView, OpsQueueName, OpsQueueView, OpsQueuesView, OpsSystemView } from '@terminal-ops/contracts';

/** 지금보다 m분 전 ISO 시각(화면의 "N분 전"이 테스트 시각과 상관없이 같게) */
export const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

export const queue = (name: OpsQueueName, over: Partial<OpsQueueView> = {}): OpsQueueView => ({
  name,
  counts: { waiting: 0, active: 0, delayed: 0, prioritized: 0, failed: 0, completed: 0 },
  paused: false,
  oldestWaitingAt: null,
  completedRecent: null,
  failedRecent: null,
  workers: 1,
  ...over,
});

export const queuesView = (queues: OpsQueueView[] = []): OpsQueuesView => ({ checkedAt: new Date().toISOString(), recentMinutes: 15, queues });

export const systemView = (over: Partial<OpsSystemView> = {}): OpsSystemView => ({
  checkedAt: new Date().toISOString(),
  api: { version: 'dev', startedAt: minutesAgo(90), node: 'v24.0.0', queuePrefix: 'terminal-ops', runWorkers: true, runSchedulers: true },
  mysql: { ok: true, latencyMs: 1.2, error: null },
  redis: { ok: true, latencyMs: 0.4, error: null },
  workers: [
    { queue: 'outbox', name: 'worker-a', idleSeconds: 1 },
    { queue: 'report', name: 'worker-a', idleSeconds: 3 },
  ],
  ...over,
});

export const outboxView = (over: Partial<OpsOutboxView> = {}): OpsOutboxView => ({
  checkedAt: new Date().toISOString(),
  counts: { PENDING: 0, QUEUED: 0, SENT: 0, FAILED: 0 },
  oldestPendingAt: null,
  oldestQueuedAt: null,
  requeueAfterMs: 60_000,
  ...over,
});

/** 대시보드가 부르는 세 GET(값을 바꾸려면 덮어쓴다) */
export const dashboardApi = (over: { queues?: OpsQueuesView; system?: OpsSystemView; outbox?: OpsOutboxView } = {}) => ({
  'GET /ops/queues': () => ({ body: over.queues ?? queuesView([queue('outbox')]) }),
  'GET /ops/system': () => ({ body: over.system ?? systemView() }),
  'GET /ops/outbox': () => ({ body: over.outbox ?? outboxView() }),
});
