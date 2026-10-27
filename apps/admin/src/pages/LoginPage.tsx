import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import type { LoginRequest, MeView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { ErrorBox } from '../components/ErrorBox';
import { setMe, useMe } from '../session';

/** 로그인(api decisions/0050). 성공하면 서버가 httpOnly 세션 쿠키를 주고, 화면은 응답(내 정보)만 기억한다 */
export function LoginPage() {
  const me = useMe();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: (body: LoginRequest) => api<MeView>('/auth/login', { method: 'POST', body }),
    onSuccess: (m) => {
      setMe(m);
      navigate(from, { replace: true });
    },
  });

  if (me) return <Navigate to={from} replace />;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate({ loginId: loginId.trim(), password } satisfies LoginRequest);
  };

  return (
    <form className="login" onSubmit={submit}>
      <h1>단말온 운영 어드민</h1>
      <label>
        아이디 <input aria-label="아이디" autoComplete="username" value={loginId} maxLength={50} onChange={(e) => setLoginId(e.target.value)} />
      </label>
      <label>
        비밀번호{' '}
        <input aria-label="비밀번호" type="password" autoComplete="current-password" value={password} maxLength={200} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <button type="submit" className="primary" disabled={!loginId.trim() || !password || login.isPending}>
        로그인
      </button>
      <ErrorBox error={login.error} />
    </form>
  );
}
