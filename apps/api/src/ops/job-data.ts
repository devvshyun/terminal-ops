/**
 * 실패 job의 data를 화면에 보이기 전에 가린다(보강 6, decisions/0072).
 * 지금 큐에 들어가는 data는 id·시리얼·주 시작일뿐이다({ shipmentId }, { outboxId }, { serialNo }, { runId }, { weekStart }, {}) —
 * 개인정보·비밀 값은 없다. 그래도 관제 화면은 "Redis에 든 것을 그대로 보여 주는 창"이 되기 쉬워, 나중에 누가 data에 값을 더해도
 * 새지 않게 이름으로 가리고 길이를 자른다(허용 목록이 아니라 차단 목록 — 새 job을 더할 때마다 이 파일을 고치지 않아도 되게. 대가: 이름이 애매한 값은 못 거른다).
 */
export const MASK = '[가림]';

/** 이름에 이 글자가 들어간 키는 값을 가린다(대소문자 무시). key는 idempotencyKey 같은 것도 가린다 — 지나치게 가리는 쪽을 고른다 */
const SECRET_KEY = /pass|secret|token|key|auth|cookie|session|phone|email|card|account|address/i;
const MAX_STRING = 100;
const MAX_ITEMS = 20;
const MAX_DEPTH = 4;

function redact(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(${value.length}자)` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[깊음]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => redact(v, depth + 1));
    return value.length > MAX_ITEMS ? [...items, `…외 ${value.length - MAX_ITEMS}개`] : items;
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? MASK : redact(v, depth + 1)]));
}

/** job.data(어떤 값이든)를 화면용 객체로. 객체가 아니면 { value }로 감싼다 */
export function redactJobData(data: unknown): Record<string, unknown> {
  if (data === null || data === undefined) return {};
  const out = redact(data, 0);
  return out !== null && typeof out === 'object' && !Array.isArray(out) ? (out as Record<string, unknown>) : { value: out };
}

/** 실패 이유 한 줄(외부 업체 응답 본문이 길게 붙을 수 있다 — 500자) */
export function shortReason(reason: string | undefined): string {
  const text = reason ?? '';
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
