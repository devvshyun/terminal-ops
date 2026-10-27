import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { MeView } from '@terminal-ops/contracts';
import { api, ApiError } from '../api/client';
import { setMe, useMe } from '../session';
import { ErrorBox } from './ErrorBox';
import { UserBar } from './UserBar';

/**
 * 로그인해야 보이는 화면들의 문. 처음에는 GET /auth/me로 서버 세션을 확인하고, 로그인 안 했으면(401) 로그인 화면으로 보낸다(돌아올 주소를 함께).
 * 가맹점주는 이 사내 어드민을 쓰지 않는다 — 안내와 로그아웃만(가맹점 화면은 다음 묶음, API는 `/me`).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
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

  if (me === undefined) return error ? <ErrorBox error={error} /> : <p>로그인 확인 중…</p>;
  if (me === null) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  if (me.role === 'MERCHANT') {
    return (
      <div className="login">
        <p>가맹점 계정은 사내 운영 어드민을 쓰지 않습니다. 가맹점 화면은 다음 묶음에서 열립니다.</p>
        <UserBar />
      </div>
    );
  }
  return <>{children}</>;
}
