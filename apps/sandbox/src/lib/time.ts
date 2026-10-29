/** 시각을 KST 'HH:mm:ss'로(시연 화면은 오늘 일만 본다) */
export function kstTime(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const k = new Date(d.getTime() + 9 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}:${pad(k.getUTCSeconds())}`;
}
