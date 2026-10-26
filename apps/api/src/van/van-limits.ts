import { MAX_RETRY_AFTER_MS } from '../common/partner-http.js';
import { PARTNER_RETRY_BASE_MS } from '../common/partner-retry.js';

/** 페이지 하나·시리얼 하나를 다시 부르는 최대 횟수(첫 시도 포함) */
export const VAN_CALL_ATTEMPTS = 5;

/**
 * 브릿지VAN 호출 하나(재시도 포함)가 하트비트 없이 걸릴 수 있는 최악 시간(ms).
 * = 시도 수 × 제한 시간 + 백오프 합(500ms·1s·2s·4s = 7.5s). 429의 Retry-After 대기는 여기 넣지 않고 checkVanHeartbeatTiming이 따로 더한다.
 */
export function vanWorstCallMs(timeoutMs: number, attempts = VAN_CALL_ATTEMPTS, baseMs = PARTNER_RETRY_BASE_MS): number {
  let backoff = 0;
  for (let k = 1; k < attempts; k++) backoff += baseMs * 2 ** (k - 1);
  return attempts * timeoutMs + backoff;
}

/**
 * 멈춤 기준(VAN_RUN_HEARTBEAT_STALE_MS)이 살아 있는 실행을 죽은 것으로 보지 않을 만큼 긴지 시작할 때 확인한다.
 * 하트비트는 "마지막 하트비트 뒤 간격이 지났을 때" 다음 확인 지점(묶음 사이·재시도 대기 앞·페이지마다)에서 나가므로,
 * 두 하트비트 사이는 최악 간격 + 호출 하나의 최악 시간 + Retry-After 대기 하나다. 기준은 그 이상이어야 한다.
 * 최종 리뷰 반영(Minor 1): 전에는 "Retry-After는 상한이 없어 넣지 않는다"고 했지만 parseRetryAfter가 MAX_RETRY_AFTER_MS(60초)로 자른다.
 * 재시도 대기 앞 확인 지점에서 간격이 아직 안 지났으면 하트비트 없이 최대 60초를 자므로 그만큼 더한다(기본값 300s ≥ 112.5s, decisions/0033).
 * @throws 조건이 틀리면 env 이름과 값을 담아 던진다(서버·워커가 뜨지 않게)
 */
export function checkVanHeartbeatTiming(v: { staleMs: number; intervalMs: number; timeoutMs: number }): void {
  if (v.intervalMs >= v.staleMs) {
    throw new Error(`환경변수 VAN_HEARTBEAT_INTERVAL_MS=${v.intervalMs}는 VAN_RUN_HEARTBEAT_STALE_MS=${v.staleMs}보다 작아야 합니다.`);
  }
  const need = v.intervalMs + vanWorstCallMs(v.timeoutMs) + MAX_RETRY_AFTER_MS;
  if (v.staleMs < need) {
    throw new Error(
      `환경변수 VAN_RUN_HEARTBEAT_STALE_MS=${v.staleMs}가 하트비트 간격 + 호출 하나의 최악 시간 + Retry-After 대기(${need}ms = ${v.intervalMs} + ${VAN_CALL_ATTEMPTS} × PARTNER_TIMEOUT_MS ${v.timeoutMs} + 백오프 + Retry-After 상한 ${MAX_RETRY_AFTER_MS})보다 짧습니다.`,
    );
  }
}
