import { useLayoutEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { registerUserChangeHandler } from '../session';

/** 로그인한 사람이 바뀌면(로그인·로그아웃·401) 서버 상태 캐시를 모두 비운다 (앞사람의 작업 데이터가 남지 않게). 점주 앱 `apps/merchant/src/components/SessionCacheSync.tsx`의 사본(decisions/0062) — 주석을 뺀 코드가 같아야 한다(`src/copies.test.ts`가 본다). 고칠 때는 두 앱을 같이 고친다 */
export function SessionCacheSync() {
  const client = useQueryClient();
  useLayoutEffect(() => {
    registerUserChangeHandler(() => client.clear());
    return () => registerUserChangeHandler(null);
  }, [client]);
  return null;
}
