import { useState } from 'react';
import { api, ApiError } from '../api/client';
import { setLoggedOut } from '../session';
import { describeError } from './ErrorBox';

/** 로그아웃: 서버 세션을 끊은 뒤 화면 쪽 로그인 정보를 비운다(캐시는 SessionCacheSync가 비운다). 점주 앱 `apps/merchant/src/components/LogoutButton.tsx`의 사본(decisions/0062) — 주석을 뺀 코드가 같아야 한다(`src/copies.test.ts`가 본다). 고칠 때는 두 앱을 같이 고친다 */
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
