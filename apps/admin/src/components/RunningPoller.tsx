import { useEffect, useRef } from 'react';

/** 진행 중인 비동기 작업(VAN 대조, 주간 리포트 보내기)이 있으면 2초마다 다시 읽는다(202 뒤 결과를 보려고, decisions/0038) */
export const RUNNING_POLL_MS = 2_000;

/** TanStack Query의 refetch 모양. cancelRefetch 기본값은 true(설치된 query-core 5.104.2 queryObserver.fetch) */
export type Refetch = (options: { cancelRefetch: boolean }) => unknown;

/**
 * 그려져 있는 동안 ms마다 refetch를 부른다. 다 끝나면 화면이 이 컴포넌트를 빼서 멈춘다.
 * 응답이 ms보다 늦으면 기본 refetch는 진행 중인 요청을 버리고 새로 불러 결과가 영영 반영되지 않는다 —
 * 그래서 cancelRefetch: false로 부른다(진행 중이면 그 요청을 그대로 기다린다).
 */
export function RunningPoller({ refetch, ms = RUNNING_POLL_MS, text = '진행 중' }: { refetch: Refetch; ms?: number; text?: string }) {
  const latest = useRef(refetch);
  latest.current = refetch;
  useEffect(() => {
    const timer = setInterval(() => void latest.current({ cancelRefetch: false }), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return (
    <span className="muted" role="status">
      {text} — {ms / 1000}초마다 다시 읽는 중
    </span>
  );
}
