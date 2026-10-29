/**
 * 넓은 화면(사무실 PC)에서 보이는 안내의 "어드민 박스 스캔" 주소(decisions/0077). 어드민 `src/apps.ts`와 같은 규칙(decisions/0067):
 * Vite env `VITE_ADMIN_APP_URL`로 바꾸고, 없거나 http·https가 아니면 로컬 어드민 개발 서버(:5173). 박스 스캔은 어드민의 `/scans`.
 */
type Env = Record<string, unknown>;

export const ADMIN_APP_DEFAULT = 'http://localhost:5173';

export function adminScanUrl(env: Env = import.meta.env): string {
  const value = env.VITE_ADMIN_APP_URL;
  const text = typeof value === 'string' ? value.trim() : '';
  const base = /^https?:\/\//i.test(text) ? text : ADMIN_APP_DEFAULT;
  return `${base.replace(/\/+$/, '')}/scans`;
}
