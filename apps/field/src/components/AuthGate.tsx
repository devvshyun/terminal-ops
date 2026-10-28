import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useSessionCheck } from '../hooks/useSessionCheck';
import { wasLoggedOutOnPurpose } from '../session';
import { ErrorBox } from './ErrorBox';
import { LogoutButton } from './LogoutButton';

/**
 * 로그인해야 보이는 화면들의 문. 처음에는 GET /auth/me로 서버 세션을 확인하고, 로그인 안 했으면 로그인 화면으로(돌아올 주소와 함께).
 * 현장 작업자 계정(FIELD)만 쓴다 — 다른 계정이면 안내와 로그아웃만(decisions/0061). 운영자는 같은 스캔·검수를 어드민에서 한다.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { me, error } = useSessionCheck();
  const location = useLocation();

  if (me === undefined) return error ? <ErrorBox error={error} /> : <p className="page">로그인 확인 중…</p>;
  if (me === null) {
    const state = wasLoggedOutOnPurpose() ? undefined : { from: `${location.pathname}${location.search}` };
    return <Navigate to="/login" replace state={state} />;
  }
  if (me.role !== 'FIELD') {
    return (
      <div className="page narrow">
        <p>이 화면은 현장 작업자 계정용입니다. 운영자·관제는 운영 어드민을, 가맹점주는 매장 화면을 쓰세요.</p>
        <LogoutButton />
      </div>
    );
  }
  return <>{children}</>;
}
