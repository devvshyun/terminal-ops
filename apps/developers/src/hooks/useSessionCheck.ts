import { useEffect, useState } from 'react';
import type { MeView } from '@terminal-ops/contracts';
import { api, ApiError } from '../api/client';
import { setMe, useMe } from '../session';

/** 내 정보를 아직 모르면 GET /auth/me로 서버 세션을 확인해 채운다. 401이면 로그인 안 한 것(null). 점주 앱 `apps/merchant/src/hooks/useSessionCheck.ts`의 사본(decisions/0062) — 주석을 뺀 코드가 같아야 한다(`src/copies.test.ts`가 본다). 고칠 때는 두 앱을 같이 고친다 */
export function useSessionCheck() {
  const me = useMe();
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (me !== undefined) return;
    let cancelled = false;
    api<MeView>('/auth/me')
      .then((m) => !cancelled && setMe(m))
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) setMe(null);
        else setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [me]);
  return { me, error };
}
