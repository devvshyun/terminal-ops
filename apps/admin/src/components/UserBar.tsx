import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { ROLE_LABEL } from '../lib/labels';
import { setMe, useMe } from '../session';

/**
 * 위쪽: 로그인한 사람(표시 이름·아이디·역할)과 로그아웃. 작업자 이름 입력(OperatorBar, decisions/0041)을 대신한다 —
 * 이력의 작업자는 이제 서버가 세션에서 정한다(api decisions/0056).
 */
export function UserBar() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  if (!me) return null;

  const logout = async () => {
    setBusy(true);
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      // 서버 세션이 이미 끝났어도 화면은 로그아웃한다
    } finally {
      queryClient.clear(); // 다른 사람이 로그인했을 때 앞사람의 화면 데이터가 보이지 않게
      setMe(null);
    }
  };

  return (
    <div className="user">
      <span>
        <strong>{me.displayName}</strong> ({me.loginId}) · <span aria-label="역할">{ROLE_LABEL[me.role]}</span>
        {me.merchantCode ? ` · ${me.merchantCode}` : null}
      </span>
      <button type="button" disabled={busy} onClick={() => void logout()}>
        로그아웃
      </button>
    </div>
  );
}
