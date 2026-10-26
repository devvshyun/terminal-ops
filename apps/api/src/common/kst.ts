/** 한국 시간(KST)은 UTC+9, 일광 절약 시간 없음 */
export const KST_OFFSET_MS = 9 * 3_600_000;

const pad = (n: number) => String(n).padStart(2, '0');

/** instant를 KST 벽시계로 옮긴 Date. getUTC*로 읽으면 KST 날짜·시각이 나온다(서버 시간대 무관) */
export function toKstWallClock(instant: Date): Date {
  return new Date(instant.getTime() + KST_OFFSET_MS);
}

/** KST 날짜 'YYYY-MM-DD' */
export function kstDate(instant: Date): string {
  const k = toKstWallClock(instant);
  return `${k.getUTCFullYear()}-${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())}`;
}

/**
 * 사람이 읽는 시각 'YYYY-MM-DD HH:mm:ss KST'(밀리초 버림). 알림 문구용 — payload는 UTC ISO 그대로 두고 문구만 바꾼다.
 * 시각으로 읽을 수 없는 값은 받은 그대로 글자로 돌려준다(문구 만들기가 알림 전체를 깨지 않게).
 */
export function formatKst(value: string | Date | undefined | null): string {
  const d = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : new Date(NaN);
  if (Number.isNaN(d.getTime())) return String(value);
  const k = toKstWallClock(d);
  return `${kstDate(d)} ${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}:${pad(k.getUTCSeconds())} KST`;
}
