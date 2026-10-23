/** 정렬된 배열의 백분위 값(가장 가까운 순위). 비어 있으면 0 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/**
 * 응답 시간 분포: 로그 간격 구간 히스토그램. 구간 경계가 이웃과 1% 비율이라 백분위 오차는 최대 1%(윗경계를 돌려준다).
 * 메모리는 값이 몇 개든 구간 수로 고정이고, 백분위를 구하는 일도 구간 수만큼만 든다.
 * 범위 밖 값은 첫·마지막 구간에 넣고(count에는 들어간다), max는 정확한 값을 따로 들고 있다.
 */
const MIN_MS = 0.001;
const MAX_MS = 1e7;
const RATIO = 1.01;
const LOG_RATIO = Math.log(RATIO);
const BUCKETS = Math.ceil(Math.log(MAX_MS / MIN_MS) / LOG_RATIO) + 1;

export interface LatencyView {
  /** 기록한 값 수(버리는 값 없음) */
  count: number;
  p50: number;
  p95: number;
  max: number;
  /** 백분위가 히스토그램 근삿값이다(실제보다 최대 1% 크게 나올 수 있다). max·count는 정확하다 */
  approx: true;
}

class LatencyHistogram {
  private readonly counts = new Uint32Array(BUCKETS);
  private count = 0;
  private max = 0;

  bucketCount(): number {
    return this.counts.length;
  }

  record(ms: number): void {
    const v = Number.isFinite(ms) && ms > 0 ? ms : 0;
    const idx = v <= MIN_MS ? 0 : Math.min(BUCKETS - 1, Math.ceil(Math.log(v / MIN_MS) / LOG_RATIO));
    this.counts[idx] += 1;
    this.count += 1;
    if (v > this.max) this.max = v;
  }

  private percentile(p: number): number {
    if (this.count === 0) return 0;
    const rank = Math.min(this.count, Math.max(1, Math.ceil((p / 100) * this.count)));
    let seen = 0;
    for (let i = 0; i < BUCKETS; i++) {
      seen += this.counts[i];
      if (seen >= rank) return Math.min(this.max, MIN_MS * RATIO ** i);
    }
    return this.max;
  }

  view(): LatencyView {
    return { count: this.count, p50: this.percentile(50), p95: this.percentile(95), max: this.max, approx: true };
  }
}

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
  /** 실패한 요청 수 = httpErrors + timeouts + networkErrors + badResponses */
  errors: number;
  /** 2xx가 아닌 응답 */
  httpErrors: number;
  /** 요청 제한 시간 초과 */
  timeouts: number;
  /** 연결 거부·끊김 등 그 밖의 소켓 오류 */
  networkErrors: number;
  /** 2xx인데 본문에 results 배열이 없는 응답 */
  badResponses: number;
  /**
   * 요청 응답 시간(ms), 보낸 시각부터 본문을 다 받거나 실패할 때까지. 성공·실패 모두 포함한다
   * (실패를 빼면 시간 초과가 사라져 p95가 낮게 보인다). 성공만은 latencyOk, 실패만은 latencyFailed
   */
  latency: LatencyView;
  latencyOk: LatencyView;
  latencyFailed: LatencyView;
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
  httpErrors = 0;
  timeouts = 0;
  networkErrors = 0;
  badResponses = 0;
  startedAt: string | null = null;
  lastTickAt: string | null = null;
  private all = new LatencyHistogram();
  private ok = new LatencyHistogram();
  private failed = new LatencyHistogram();

  /** 응답 시간을 기록한다. ok는 요청이 성공(2xx이고 results 배열 있음)했는지 */
  recordLatency(ms: number, ok: boolean): void {
    this.all.record(ms);
    (ok ? this.ok : this.failed).record(ms);
  }

  /** 히스토그램 구간 수(값이 몇 개든 일정) */
  bucketCount(): number {
    return this.all.bucketCount();
  }

  view(): StatsView {
    return {
      ticks: this.ticks,
      skippedTicks: this.skippedTicks,
      requests: this.requests,
      heartbeatsSent: this.heartbeatsSent,
      heartbeatsAccepted: this.heartbeatsAccepted,
      heartbeatsRejected: this.heartbeatsRejected,
      errors: this.errors,
      httpErrors: this.httpErrors,
      timeouts: this.timeouts,
      networkErrors: this.networkErrors,
      badResponses: this.badResponses,
      latency: this.all.view(),
      latencyOk: this.ok.view(),
      latencyFailed: this.failed.view(),
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
    };
  }
}
