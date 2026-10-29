import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useSessionCheck } from '../hooks/useSessionCheck';
import { wasLoggedOutOnPurpose } from '../session';
import { ErrorBox } from './ErrorBox';
import { LogoutButton } from './LogoutButton';

/**
 * 로그인해야 보이는 화면들의 문. 처음에는 GET /auth/me로 서버 세션을 확인하고, 로그인 안 했으면 로그인 화면으로(돌아올 주소와 함께).
 * 관제(MONITOR)와 ADMIN만 쓴다 — 서버의 /ops 보기 규칙(OPS_VIEW)과 같다(decisions/0070·0074). 다른 계정이면 안내와 로그아웃만.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { me, error } = useSessionCheck();
  const location = useLocation();

  if (me === undefined) return error ? <ErrorBox error={error} /> : <p className="page">로그인 확인 중…</p>;
  if (me === null) {
    const state = wasLoggedOutOnPurpose() ? undefined : { from: `${location.pathname}${location.search}` };
    return <Navigate to="/login" replace state={state} />;
  }
  if (me.role !== 'MONITOR' && me.role !== 'ADMIN') {
    return (
      <div className="page narrow">
        <p>이 화면은 관제·ADMIN 계정용입니다. 운영자는 운영 어드민을, 현장 작업자는 현장 화면을, 가맹점주는 매장 화면을 쓰세요.</p>
        <LogoutButton />
      </div>
    );
  }
  return <>{children}</>;
}

/** 관제 작업(다시 시도·지우기·sweep)을 할 수 있나 — 서버 규칙과 같게 MONITOR만. ADMIN은 보기만(단추 대신 안내) */
export const canOperate = (role: string | undefined) => role === 'MONITOR';
