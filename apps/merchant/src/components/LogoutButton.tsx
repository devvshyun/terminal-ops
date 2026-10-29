import { useState } from 'react';
import { api, ApiError } from '../api/client';
import { setLoggedOut } from '../session';
import { describeError } from './ErrorBox';

// 현장 앱 `apps/field/src/components/LogoutButton.tsx`·관제 앱 `apps/console/src/components/LogoutButton.tsx`에 사본이 있다 — 같이 고친다(decisions/0062·0075, 두 앱의 `src/copies.test.ts`가 코드 차이를 본다)
/** 로그아웃: 서버 세션을 끊은 뒤 화면 쪽 로그인 정보를 비운다(캐시는 SessionCacheSync가 비운다). 어드민 UserBar와 같은 규칙 */
export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const logout = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch (e) {
      // 401이면 서버 세션이 이미 끝난 것. 그 밖의 실패는 세션이 남았을 수 있어 로그인 상태를 유지하고 알린다
      if (!(e instanceof ApiError && e.status === 401)) {
        setError(e);
        setBusy(false);
        return;
      }
    }
    setLoggedOut();
  };

  return (
    <>
      <button type="button" className="link" disabled={busy} onClick={() => void logout()}>
        로그아웃
      </button>
      {error ? (
        <div className="error logout-error" role="alert">
          로그아웃하지 못했습니다. 로그인 상태가 그대로입니다. 다시 시도하세요. ({describeError(error).detail})
        </div>
      ) : null}
    </>
  );
}
