import { useEffect, useRef } from 'react';

/** 진행 중인 비동기 작업(VAN 대조, 주간 리포트 보내기)이 있으면 2초마다 다시 읽는다(202 뒤 결과를 보려고, decisions/0038) */
export const RUNNING_POLL_MS = 2_000;

/** 그려져 있는 동안 ms마다 refetch를 부른다. 다 끝나면 화면이 이 컴포넌트를 빼서 멈춘다 */
export function RunningPoller({ refetch, ms = RUNNING_POLL_MS, text = '진행 중' }: { refetch: () => void; ms?: number; text?: string }) {
  const latest = useRef(refetch);
  latest.current = refetch;
  useEffect(() => {
    const timer = setInterval(() => latest.current(), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return (
    <span className="muted" role="status">
      {text} — {ms / 1000}초마다 다시 읽는 중
    </span>
  );
}
