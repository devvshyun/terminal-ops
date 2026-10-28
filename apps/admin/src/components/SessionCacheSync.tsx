import { useLayoutEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { registerUserChangeHandler } from '../session';

/**
 * 로그인한 사람이 바뀌면(로그인·로그아웃·401로 세션 끝남) 서버 상태 캐시를 모두 비운다 — 한 곳에서.
 * 자식 컴포넌트의 effect보다 먼저 등록되도록 layout effect로 둔다.
 *
 * `clear()`는 캐시에서 쿼리를 빼낸다. 비우는 순간 이미 나가 있던 요청(앞사람 세션으로 보낸 것)의 응답은
 * 빠진 쿼리에 쓰이므로 새 캐시에 들어오지 않는다 — 의도한 동작이다(앞사람의 데이터를 다음 사람에게 보이지 않게).
 * 새 사람의 화면은 자기 세션으로 다시 부른다.
 */
export function SessionCacheSync() {
  const client = useQueryClient();
  useLayoutEffect(() => {
    registerUserChangeHandler(() => client.clear());
    return () => registerUserChangeHandler(null);
  }, [client]);
  return null;
}
