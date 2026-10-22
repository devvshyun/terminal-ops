import { PartnerPermanentError, PartnerRateLimitedError, PartnerTransientError } from './partner-errors.js';

/** Retry-After(초 또는 HTTP 날짜)를 ms로. 없거나 못 읽으면 기본 1초 */
export function parseRetryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 1000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? 1000 : Math.max(0, at - now);
}

/**
 * 외부 업체 HTTP 호출. 2xx면 본문 문자열을 돌려주고, 아니면 재시도 판단에 쓰는 오류로 바꾼다.
 * - 429 → PartnerRateLimitedError(Retry-After)
 * - 5xx, 타임아웃, 연결 실패 → PartnerTransientError
 * - 그 밖의 4xx → PartnerPermanentError
 */
export async function partnerFetch(label: string, url: string, init: RequestInit, timeoutMs: number): Promise<string> {
  let res: Response;
  let body: string;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    // 헤더 뒤 본문을 읽다가 타임아웃·연결 끊김이 나도 같은 일시 오류로 본다.
    body = await res.text();
  } catch (error) {
    // AbortSignal.timeout은 TimeoutError, 연결 실패는 TypeError(fetch failed)
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new PartnerTransientError(`${label} 호출 실패(${reason})`);
  }
  if (res.ok) return body;
  const message = `${label} 응답 ${res.status}: ${body.slice(0, 200)}`;
  if (res.status === 429) throw new PartnerRateLimitedError(message, parseRetryAfter(res.headers.get('retry-after')));
  if (res.status >= 500) throw new PartnerTransientError(message);
  throw new PartnerPermanentError(message);
}
