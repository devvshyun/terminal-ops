import { useSyncExternalStore } from 'react';

/**
 * 자동 새로고침(보강 6, decisions/0076). 관제 화면은 띄워 두고 보는 화면이라 읽기 쿼리마다 10초 간격(refetchInterval)을 건다.
 * - 탭이 안 보이면 멈춘다: TanStack Query는 refetchIntervalInBackground가 false(기본)면 문서가 숨었을 때(focusManager) 간격 읽기를 건너뛴다
 * - 위 막대의 단추로 끌 수 있다(장애를 들여다보는 동안 숫자가 바뀌지 않게). 켜고 끈 것은 이 탭에서만 — 저장하지 않는다
 * - 관제 작업(다시 시도·지우기·복구 sweep) 뒤에는 간격을 기다리지 않고 그 작업이 바꾸는 쿼리를 무효화한다(api/query-keys.ts)
 */
export const REFRESH_MS = 10_000;

let enabled = true;
let intervalMs = REFRESH_MS;
const listeners = new Set<() => void>();

export function setAutoRefresh(on: boolean): void {
  enabled = on;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAutoRefresh(): boolean {
  return useSyncExternalStore(subscribe, () => enabled);
}

/** 읽기 쿼리에 붙이는 간격: 켜져 있으면 REFRESH_MS, 꺼져 있으면 false */
export function useRefetchInterval(): number | false {
  return useAutoRefresh() ? intervalMs : false;
}

/** 테스트용: 켜짐으로 되돌리고 간격을 정한다(test/render.tsx가 그릴 때마다 부른다 — 짧게 주면 실제 시계로 몇십 ms) */
export function resetAutoRefreshForTest(ms = REFRESH_MS): void {
  intervalMs = ms;
  setAutoRefresh(true);
}
