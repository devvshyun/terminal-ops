import { useEffect, useState } from 'react';

/** 지금 시각을 intervalMs마다 다시 읽는다. "N초 전" 같은 표시가 시간이 지나면 저절로 바뀌게 한다 */
export function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
