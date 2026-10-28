import { useEffect, useState } from 'react';
import type { MeView } from '@terminal-ops/contracts';
import { api, ApiError } from '../api/client';
import { setMe, useMe } from '../session';

/** 내 정보를 아직 모르면 GET /auth/me로 서버 세션을 확인해 채운다. 401이면 로그인 안 한 것(null). 어드민과 같다 */
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
