/** 한국 시간(KST)은 UTC+9, 일광 절약 시간 없음. api의 common/kst.ts와 같은 규칙(decisions/0041) */
const KST_OFFSET_MS = 9 * 3_600_000;

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * api가 주는 UTC ISO 시각을 'YYYY-MM-DD HH:mm:ss KST'로(밀리초 버림). 브라우저 시간대와 상관없이 KST로 쓴다.
 * null·undefined는 '-', 시각으로 읽을 수 없는 값은 받은 그대로.
 */
export function formatKst(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const k = new Date(d.getTime() + KST_OFFSET_MS);
  return `${k.getUTCFullYear()}-${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())} ${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}:${pad(k.getUTCSeconds())} KST`;
}

/** 오늘(KST) 날짜 'YYYY-MM-DD' */
export function kstToday(now = new Date()): string {
  return formatKst(now.toISOString()).slice(0, 10);
}

/**
 * 집계 시각이 지금보다 얼마나 전인가: 1분 안은 'N초 전', 그 뒤는 'N분 전'(내림). 시계 차이로 미래면 '0초 전'.
 * 시각으로 읽을 수 없으면 ''. 대시보드의 "N초 전 기준"(api decisions/0044)
 */
export function ageText(iso: string, now: Date): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const sec = Math.max(0, Math.floor((now.getTime() - t) / 1000));
  return sec < 60 ? `${sec}초 전` : `${Math.floor(sec / 60)}분 전`;
}
