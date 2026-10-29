import { useState } from 'react';
import { api, ApiError } from '../api/client';
import { ROLE_LABEL } from '../lib/labels';
import { setLoggedOut, useMe } from '../session';
import { describeError } from './ErrorBox';

/**
 * 위쪽: 로그인한 사람(표시 이름·아이디·역할)과 로그아웃. 작업자 이름 입력(OperatorBar, decisions/0041)을 대신한다 —
 * 이력의 작업자는 이제 서버가 세션에서 정한다(api decisions/0056).
 */
export function UserBar() {
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!me) return null;

  const logout = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch (e) {
      // 401이면 서버 세션이 이미 끝난 것(api()가 로그인 정보를 비워 둠). 그 밖의 실패는 세션이 남았을 수 있어 로그인 상태를 유지하고 알린다
      if (!(e instanceof ApiError && e.status === 401)) {
        setError(e);
        setBusy(false);
        return;
      }
    }
    // 캐시는 setMe가 비운다(SessionCacheSync). 일부러 한 로그아웃이라 AuthGate가 돌아올 주소(from) 없이 /login으로 보낸다
    setLoggedOut();
  };

  return (
    <div className="user">
      <span className="avatar" aria-hidden="true">
        {me.displayName.slice(0, 1)}
      </span>
      <span className="who">
        <strong>{me.displayName}</strong> ({me.loginId}) · <span aria-label="역할">{ROLE_LABEL[me.role]}</span>
        {me.merchantCode ? ` · ${me.merchantCode}` : null}
      </span>
      <button type="button" disabled={busy} onClick={() => void logout()}>
        로그아웃
      </button>
      {error ? <span className="error" role="alert">
          로그아웃하지 못했습니다. 로그인 상태가 그대로입니다. 다시 시도하세요. ({describeError(error).detail})
        </span> : null}
    </div>
  );
}
