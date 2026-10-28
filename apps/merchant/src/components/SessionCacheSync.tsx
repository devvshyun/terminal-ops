import { useLayoutEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { registerUserChangeHandler } from '../session';

/** 로그인한 사람이 바뀌면(로그인·로그아웃·401) 서버 상태 캐시를 모두 비운다 — 어드민 SessionCacheSync와 같다(앞 점주의 매장 데이터가 남지 않게) */
export function SessionCacheSync() {
  const client = useQueryClient();
  useLayoutEffect(() => {
    registerUserChangeHandler(() => client.clear());
    return () => registerUserChangeHandler(null);
  }, [client]);
  return null;
}
