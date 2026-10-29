/**
 * 쿼리 키. 모두 'console'로 시작한다(점주·현장 앱과 같은 방식 — 화면이 몇 개 안 된다).
 * 관제 작업 뒤에는 그 작업이 바꾸는 것만 무효화한다: 다시 시도·지우기 → 큐 요약·실패 목록·작업 기록, 복구 sweep → Outbox·작업 기록.
 */
export const keys = {
  all: ['console'] as const,
  queues: ['console', 'queues'] as const,
  system: ['console', 'system'] as const,
  outbox: ['console', 'outbox'] as const,
  schedulers: ['console', 'schedulers'] as const,
  errors: ['console', 'errors'] as const,
  failedAll: ['console', 'failed'] as const,
  failed: (queue: string, start: number) => ['console', 'failed', queue, start] as const,
  actions: ['console', 'actions'] as const,
};
