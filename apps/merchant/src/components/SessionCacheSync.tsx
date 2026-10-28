import { useLayoutEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { registerUserChangeHandler } from '../session';

// 현장 앱 `apps/field/src/components/SessionCacheSync.tsx`에 사본이 있다 — 같이 고친다(decisions/0062, 현장 `src/copies.test.ts`가 코드 차이를 본다)
/** 로그인한 사람이 바뀌면(로그인·로그아웃·401) 서버 상태 캐시를 모두 비운다 — 어드민 SessionCacheSync와 같다(앞 점주의 매장 데이터가 남지 않게) */
export function SessionCacheSync() {
  const client = useQueryClient();
  useLayoutEffect(() => {
    registerUserChangeHandler(() => client.clear());
    return () => registerUserChangeHandler(null);
  }, [client]);
  return null;
}
