/**
 * 쿼리 키. 모두 'demo'로 시작한다(다른 화면 앱과 같은 방식). 실행 단추가 끝나면 keys.all을 통째로 무효화한다 —
 * 시연 홈은 한 화면에 결과 패널이 몇 개뿐이라 고르지 않고 다시 읽는다.
 */
export const keys = {
  all: ['demo'] as const,
  dashboard: ['demo', 'dashboard'] as const,
  anomalies: ['demo', 'anomalies'] as const,
  purchaseOrders: ['demo', 'purchase-orders'] as const,
  reconciliation: (poNo: string) => ['demo', 'reconciliation', poNo] as const,
  terminal: (serialNo: string) => ['demo', 'terminal', serialNo] as const,
  connectivity: (serialNo: string) => ['demo', 'connectivity', serialNo] as const,
  syncRuns: (filter: { job?: string; limit: number }) => ['demo', 'sync-runs', filter] as const,
  tickets: ['demo', 'tickets'] as const,
  rollouts: ['demo', 'rollouts'] as const,
  partnersConfig: ['demo', 'partners-config'] as const,
  partnerRequests: ['demo', 'partner-requests'] as const,
  toktok: ['demo', 'toktok'] as const,
  simConfig: ['demo', 'sim-config'] as const,
};
