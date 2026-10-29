import type { PartnerKeyView, PartnerScope } from '@terminal-ops/contracts';

/**
 * 키 범위(scope) 이름(decisions/0054). contracts는 타입만 내보내 값 목록이 없어 여기 둔다 —
 * Record라 contracts에 scope가 늘면 tsc가 여기를 고치라고 한다. 순서는 발급 폼의 고르기 순서.
 */
export const SCOPE_LABEL: Record<PartnerScope, string> = {
  'terminal-status:read': '단말기 상태',
  'merchant-terminals:read': '가맹점 단말기 목록',
};
export const PARTNER_SCOPES = Object.keys(SCOPE_LABEL) as PartnerScope[];

/** 범위 목록을 발급 폼 순서대로 이름으로 */
export const scopesText = (scopes: PartnerScope[]) =>
  PARTNER_SCOPES.filter((s) => scopes.includes(s))
    .map((s) => SCOPE_LABEL[s])
    .join(' · ');

export type KeyState = 'active' | 'revoked' | 'expired';

/** 키 상태 — 서버의 키 확인(verify)과 같은 기준: 폐기가 먼저, 그다음 만료 시각이 지났나(화면 시계) */
export function keyState(k: Pick<PartnerKeyView, 'revokedAt' | 'expiresAt'>, now: Date): KeyState {
  if (k.revokedAt) return 'revoked';
  if (k.expiresAt && new Date(k.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

export const KEY_STATE_LABEL: Record<KeyState, string> = { active: '사용 중', revoked: '폐기됨', expired: '만료됨' };

/** 상태 코드 묶음(색): 2xx·3xx는 성공 쪽, 4xx 노랑, 5xx 빨강 */
export const codeClass = (status: number) => (status >= 500 ? 'code-5xx' : status >= 400 ? 'code-4xx' : 'code-2xx');

/** 업체 코드 규칙(api `PARTNER_CODE`와 같다) */
export const PARTNER_CODE = /^[A-Z0-9-]{2,20}$/;

/** 만료일(날짜 입력 'YYYY-MM-DD') → 그날 끝 KST 23:59:59의 UTC ISO. 빈 값은 null(만료 없음) */
export function endOfKstDay(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 23 - 9, 59, 59)).toISOString();
}
