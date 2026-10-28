import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useSessionCheck } from '../hooks/useSessionCheck';
import { wasLoggedOutOnPurpose } from '../session';
import { ErrorBox } from './ErrorBox';
import { UserBar } from './UserBar';

/**
 * 로그인해야 보이는 화면들의 문. 처음에는 GET /auth/me로 서버 세션을 확인하고, 로그인 안 했으면(401) 로그인 화면으로 보낸다(돌아올 주소를 함께).
 * 가맹점주는 이 사내 어드민을 쓰지 않는다 — 안내와 로그아웃만(가맹점 화면은 다음 묶음, API는 `/me`).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { me, error } = useSessionCheck();
  const location = useLocation();

  if (me === undefined) return error ? <ErrorBox error={error} /> : <p>로그인 확인 중…</p>;
  if (me === null) {
    // 일부러 로그아웃했으면 돌아올 주소 없이(다음 사람이 앞사람의 화면으로 들어가지 않게), 세션이 끝난 거면 그 화면으로 돌아오게
    const state = wasLoggedOutOnPurpose() ? undefined : { from: `${location.pathname}${location.search}` };
    return <Navigate to="/login" replace state={state} />;
  }
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
