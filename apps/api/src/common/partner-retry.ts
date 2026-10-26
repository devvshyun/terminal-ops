import { PartnerRateLimitedError, PartnerTransientError, type PartnerError } from './partner-errors.js';

/** 재시도 기본 간격(ms). 택배 추적 job의 'carrier' 백오프와 같은 값이다(decisions/0014) */
export const PARTNER_RETRY_BASE_MS = 500;

/**
 * 다음 시도까지 기다릴 시간. 429면 업체가 알려 준 Retry-After(기본 간격보다 짧으면 기본 간격),
 * 그 밖에는 기본 간격 × 2^(시도-1) (500ms·1s·2s·4s…). 택배 추적 job(BullMQ backoffStrategy)과 한 job 안의 재시도가 같은 규칙을 쓴다.
 * @param attempt 방금 실패한 시도 번호(1부터)
 */
export function partnerBackoffMs(attempt: number, error?: Error, baseMs = PARTNER_RETRY_BASE_MS): number {
  if (error instanceof PartnerRateLimitedError) return Math.max(error.retryAfterMs, baseMs);
  return baseMs * 2 ** (attempt - 1);
}

export interface PartnerRetryOptions {
  /** 최대 시도 횟수(첫 시도 포함) */
  attempts: number;
  baseMs?: number;
  /** 테스트에서 기다리지 않게 바꾼다 */
  sleep?: (ms: number) => Promise<void>;
  /** 다시 하기 직전에 부른다(재시도 수 세기·로그) */
  onRetry?: (error: PartnerError, attempt: number, delayMs: number) => void;
  /**
   * 기다리기 직전에 부른다(onRetry 다음). 긴 작업이 기다리는 동안에도 살아 있다는 하트비트를 보낼 때 쓴다(decisions/0033).
   * 던지면 더 기다리지 않고 그 오류로 끝난다.
   */
  beforeWait?: () => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 외부 업체 호출을 한 job 안에서 다시 한다. 429·5xx·타임아웃(PartnerRateLimitedError·PartnerTransientError)만 다시 하고,
 * 영구 오류(4xx·형식 오류)와 그 밖의 오류는 바로 던진다. VAN 목록처럼 수백 페이지를 이어 받는 작업은 페이지 하나가 실패했다고
 * job 전체를 처음부터 다시 하면 안 되므로 BullMQ 재시도 대신 이것을 쓴다(decisions/0033).
 */
export async function withPartnerRetry<T>(fn: () => Promise<T>, opts: PartnerRetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const retryable = error instanceof PartnerRateLimitedError || error instanceof PartnerTransientError;
      if (!retryable || attempt >= opts.attempts) throw error;
      const delayMs = partnerBackoffMs(attempt, error, opts.baseMs);
      opts.onRetry?.(error, attempt, delayMs);
      await opts.beforeWait?.();
      await (opts.sleep ?? defaultSleep)(delayMs);
    }
  }
}
