/** 정렬된 배열의 백분위 값(가장 가까운 순위). 비어 있으면 0 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** 응답 시간 표본 상한. 넘으면 오래된 것부터 버리지 않고 더 담지 않는다(실험 한 번에 충분한 양) */
const MAX_SAMPLES = 500_000;

export interface StatsView {
  /** 하트비트 주기 수(보낸 주기) */
  ticks: number;
  /** 앞 주기가 아직 끝나지 않아 건너뛴 주기 수. 0보다 크면 주기 안에 다 보내지 못한 것이다 */
  skippedTicks: number;
  /** 보낸 HTTP 요청 수 */
  requests: number;
  /** 보낸 하트비트 수(요청 안의 항목 수 합) */
  heartbeatsSent: number;
  /** 응답의 행별 결과가 OK인 수 */
  heartbeatsAccepted: number;
  /** 행별 결과가 OK가 아닌 수(IGNORED_NOT_IN_SERVICE 등) */
  heartbeatsRejected: number;
  /** 2xx가 아닌 응답·연결 실패·시간 초과 */
  errors: number;
  /** 요청 응답 시간(ms) */
  latency: { count: number; p50: number; p95: number; max: number };
  startedAt: string | null;
  lastTickAt: string | null;
}

export class SimStats {
  ticks = 0;
  skippedTicks = 0;
  requests = 0;
  heartbeatsSent = 0;
  heartbeatsAccepted = 0;
  heartbeatsRejected = 0;
  errors = 0;
  startedAt: string | null = null;
  lastTickAt: string | null = null;
  private latencies: number[] = [];

  recordLatency(ms: number): void {
    if (this.latencies.length < MAX_SAMPLES) this.latencies.push(ms);
  }

  view(): StatsView {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      ticks: this.ticks,
      skippedTicks: this.skippedTicks,
      requests: this.requests,
      heartbeatsSent: this.heartbeatsSent,
      heartbeatsAccepted: this.heartbeatsAccepted,
      heartbeatsRejected: this.heartbeatsRejected,
      errors: this.errors,
      latency: {
        count: sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        max: sorted.at(-1) ?? 0,
      },
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
    };
  }
}
