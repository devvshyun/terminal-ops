import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { LoginRequest, MeView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { useSessionCheck } from '../hooks/useSessionCheck';
import { setMe } from '../session';
import { ErrorBox } from './ErrorBox';
import { LogoutButton } from './LogoutButton';

/**
 * 시연자 로그인(decisions/0092). 아이디는 운영자 `operator`를 미리 채우고 비밀번호는 사람이 넣는다(값은 apps/api/src/db/seed-accounts.ts —
 * 화면 코드에 굳히지 않는다). 이 호스트(demo.localhost)의 쿠키라 다른 화면 로그인과 섞이지 않는다(0088).
 */
export function LoginBox() {
  const { me } = useSessionCheck();
  const [loginId, setLoginId] = useState('operator');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: (body: LoginRequest) => api<MeView>('/auth/login', { method: 'POST', body }),
    onSuccess: (m) => {
      setPassword('');
      setMe(m);
    },
  });
  if (me) {
    return (
      <div className="who">
        <span className="avatar" aria-hidden="true">
          {me.displayName.slice(0, 1)}
        </span>
        <span>{me.displayName}</span>
        <LogoutButton />
      </div>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate({ loginId: loginId.trim(), password });
  };
  return (
    <form className="login-inline" onSubmit={submit} aria-label="시연자 로그인">
      <input aria-label="아이디" value={loginId} maxLength={50} autoComplete="username" onChange={(e) => setLoginId(e.target.value)} />
      <input aria-label="비밀번호" type="password" placeholder="비밀번호" value={password} maxLength={200} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
      <button type="submit" className="primary" disabled={!loginId.trim() || !password || login.isPending}>
        로그인
      </button>
      {login.error ? <ErrorBox error={login.error} /> : null}
    </form>
  );
}
