// 현장 앱 `apps/field/src/lib/format.ts`에 사본이 있다 — 같이 고친다(decisions/0062, 현장 `src/copies.test.ts`가 코드 차이를 본다)
/** 한국 시간(KST)은 UTC+9, 일광 절약 시간 없음. api common/kst.ts·어드민 lib/format.ts와 같은 규칙(같은 테스트 값으로 맞춘다, decisions/0058) */
const KST_OFFSET_MS = 9 * 3_600_000;

const pad = (n: number) => String(n).padStart(2, '0');

/** api가 주는 UTC ISO 시각을 'YYYY-MM-DD HH:mm:ss KST'로(밀리초 버림). null·undefined는 '-', 읽을 수 없는 값은 그대로 */
export function formatKst(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const k = new Date(d.getTime() + KST_OFFSET_MS);
  return `${k.getUTCFullYear()}-${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())} ${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}:${pad(k.getUTCSeconds())} KST`;
}

/** 휴대폰 화면용 짧은 KST: 'MM-DD HH:mm' */
export function formatKstShort(value: string | null | undefined): string {
  const full = formatKst(value);
  return /^\d{4}-/.test(full) ? full.slice(5, 16) : full;
}

/** 지금보다 얼마나 전인가: 1분 안 '방금 전', 1시간 안 'N분 전', 하루 안 'N시간 전', 그 뒤 'N일 전'(내림). 미래(시계 차이)는 '방금 전' */
export function agoText(iso: string, now: Date): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const min = Math.floor(Math.max(0, now.getTime() - t) / 60_000);
  if (min < 1) return '방금 전';
  if (min < 60) return `${min}분 전`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}시간 전`;
  return `${Math.floor(min / (24 * 60))}일 전`;
}
