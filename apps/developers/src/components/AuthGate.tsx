import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useSessionCheck } from '../hooks/useSessionCheck';
import { wasLoggedOutOnPurpose } from '../session';
import { ErrorBox } from './ErrorBox';
import { LogoutButton } from './LogoutButton';

/**
 * 로그인해야 보이는 화면들의 문. 처음에는 GET /auth/me로 서버 세션을 확인하고, 로그인 안 했으면 로그인 화면으로(돌아올 주소와 함께).
 * ADMIN만 쓴다 — 서버의 /admin/partners·partner-keys·partner-calls 규칙과 같다(decisions/0080). 다른 계정이면 안내와 로그아웃만(막는 곳은 서버다).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { me, error } = useSessionCheck();
  const location = useLocation();

  if (me === undefined) return error ? <ErrorBox error={error} /> : <p className="page">로그인 확인 중…</p>;
  if (me === null) {
    const state = wasLoggedOutOnPurpose() ? undefined : { from: `${location.pathname}${location.search}` };
    return <Navigate to="/login" replace state={state} />;
  }
  if (me.role !== 'ADMIN') {
    return (
      <div className="page narrow">
        <p>이 화면은 ADMIN 계정용입니다. 외부 업체 키 발급·폐기는 ADMIN만 합니다. 운영자는 운영 어드민을, 관제는 운영 관제를 쓰세요.</p>
        <LogoutButton />
      </div>
    );
  }
  return <>{children}</>;
}
