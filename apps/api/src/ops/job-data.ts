/**
 * 실패 job의 data를 화면에 보이기 전에 가린다(보강 6, decisions/0072).
 * 지금 큐에 들어가는 data는 id·시리얼·주 시작일뿐이다({ shipmentId }, { outboxId }, { serialNo }, { runId }, { weekStart }, {}) —
 * 개인정보·비밀 값은 없다. 그래도 관제 화면은 "Redis에 든 것을 그대로 보여 주는 창"이 되기 쉬워, 나중에 누가 data에 값을 더해도
 * 새지 않게 이름으로 가리고 길이를 자른다(허용 목록이 아니라 차단 목록 — 새 job을 더할 때마다 이 파일을 고치지 않아도 되게. 대가: 이름이 애매한 값은 못 거른다).
 */
export const MASK = '[가림]';

/**
 * 이름에 이 글자가 들어간 키는 값을 가린다(대소문자 무시). key는 idempotencyKey 같은 것도 가린다 — 지나치게 가리는 쪽을 고른다.
 * tel·mobile·addr·contact·credential·bearer·jwt·private는 Task 2 리뷰 반영으로 더했다(tel은 hotel 같은 이름도 가린다 — 지나치게 가리는 쪽).
 */
const SECRET_KEY = /pass|secret|token|key|auth|cookie|session|phone|tel|mobile|email|contact|card|account|addr|credential|bearer|jwt|private/i;
/** 실패 이유 속 전화번호(0으로 시작하는 9~11자리, 하이픈 있어도 없어도)·이메일. 시리얼(SN1-0001)·id·HTTP 상태는 닿지 않는다 */
const PHONE = /(?<!\d)0\d{1,2}-?\d{3,4}-?\d{4}(?!\d)/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
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

/**
 * 오류 글 속 전화번호·이메일 모양을 [가림]으로(이메일 먼저 — 이메일 안의 숫자가 번호로 먼저 잡히지 않게). 자르지 않는다 — 부르는 쪽이 가린 뒤에 자른다
 * (먼저 자르면 잘린 자리에 번호 반쪽이 남는다). 실패 job의 실패 이유·감사 기록 detail(shortReason)과 최근 오류 네 출처의 글(ops-errors.service.ts)이
 * 같은 함수를 쓴다(최종 리뷰 Important 1 — 알림·택배 추적 실패는 최근 오류 화면에만 나온다, decisions/0072 보탬).
 */
export function maskPii(text: string): string {
  return text.replace(EMAIL, MASK).replace(PHONE, MASK);
}

/**
 * 실패 이유 한 줄(외부 업체 응답 본문이 길게 붙을 수 있다 — 500자). 업체 오류 글에 수신자 번호·이메일이 섞여 올 수 있어
 * 전화번호·이메일 모양은 가린 뒤 자른다(Task 2 리뷰 반영, maskPii). 그 밖의 글은 그대로다(decisions/0072 대가).
 */
export function shortReason(reason: string | undefined): string {
  const text = maskPii(reason ?? '');
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
