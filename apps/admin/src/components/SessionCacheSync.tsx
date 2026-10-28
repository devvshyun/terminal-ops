import { useLayoutEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { registerUserChangeHandler } from '../session';

/**
 * 로그인한 사람이 바뀌면(로그인·로그아웃·401로 세션 끝남) 서버 상태 캐시를 모두 비운다 — 한 곳에서.
 * 자식 컴포넌트의 effect보다 먼저 등록되도록 layout effect로 둔다.
 */
export function SessionCacheSync() {
  const client = useQueryClient();
  useLayoutEffect(() => {
    registerUserChangeHandler(() => client.clear());
    return () => registerUserChangeHandler(null);
  }, [client]);
  return null;
}
