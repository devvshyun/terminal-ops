/** BullMQ `Queue.getMetrics()`가 주는 것 중 여기서 쓰는 부분 */
export interface MetricsSnapshot {
  meta: { count: number; prevTS: number; prevCount: number };
  data: number[];
}

const MINUTE_MS = 60_000;

/**
 * BullMQ 분 단위 metrics에서 최근 `minutes`분(지금 분 포함) 동안 끝난 job 수(보강 6, decisions/0071). 기록이 한 번도 없으면 null.
 *
 * BullMQ는 job이 끝날 때만 metrics를 갱신한다(collectMetrics 스크립트). 갱신 시각의 분이 바뀌었으면 앞 분의 수(count − prevCount)를
 * data 앞에 넣고(사이에 빈 분이 있으면 0을 채운다) prevTS·prevCount를 지금으로 옮긴다. 그래서
 * - data[i]는 "마지막 갱신 분(prevTS의 분)보다 i+1분 앞"의 수이고
 * - 마지막 갱신 분 자체의 수는 아직 data에 없고 `count − prevCount`다(사전 검증: 막 끝난 job 2개는 data가 [], meta.count 2).
 * 한동안 끝난 job이 없으면 data가 그때에 멈춰 있다 — 지금 시각으로 창을 잘라야 오래된 수를 "최근"으로 세지 않는다.
 */
export function recentCount(m: MetricsSnapshot, now: number, minutes: number): number | null {
  const prevTS = Number(m.meta.prevTS) || 0;
  if (prevTS === 0) return null;
  const nowMinute = Math.floor(now / MINUTE_MS);
  const lastMinute = Math.floor(prevTS / MINUTE_MS);
  const from = nowMinute - minutes + 1;
  const inWindow = (minute: number) => minute >= from && minute <= nowMinute;
  let sum = inWindow(lastMinute) ? Number(m.meta.count) - Number(m.meta.prevCount) : 0;
  m.data.forEach((n, i) => {
    if (inWindow(lastMinute - 1 - i)) sum += Number(n);
  });
  return sum;
}
