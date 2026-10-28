import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useSessionCheck } from '../hooks/useSessionCheck';
import { wasLoggedOutOnPurpose } from '../session';
import { ErrorBox } from './ErrorBox';
import { LogoutButton } from './LogoutButton';

/**
 * 로그인해야 보이는 화면들의 문. 처음에는 GET /auth/me로 서버 세션을 확인하고, 로그인 안 했으면 로그인 화면으로(돌아올 주소와 함께).
 * 가맹점 계정(MERCHANT)만 쓴다 — 사내 직원 계정이면 안내와 로그아웃만(어드민의 반대, decisions/0057). 서버도 `/me`를 MERCHANT만 받는다(403).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { me, error } = useSessionCheck();
  const location = useLocation();

  if (me === undefined) return error ? <ErrorBox error={error} /> : <p className="page">로그인 확인 중…</p>;
  if (me === null) {
    const state = wasLoggedOutOnPurpose() ? undefined : { from: `${location.pathname}${location.search}` };
    return <Navigate to="/login" replace state={state} />;
  }
  if (me.role !== 'MERCHANT') {
    return (
      <div className="page narrow">
        <p>이 화면은 가맹점(점주) 계정용입니다. 사내 직원 계정은 운영 어드민을 쓰세요.</p>
        <LogoutButton />
      </div>
    );
  }
  return <>{children}</>;
}
