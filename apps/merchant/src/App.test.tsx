import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { getMe } from './session';
import { mockApi, OWNER, renderApp } from './test/render';

const STORE = { code: 'GANGNAM-KIMBAP', name: '강남김밥', address: '서울 강남구' };

describe('로그인 문과 화면 틀 (보강 3, decisions/0057)', () => {
  it('로그인 안 했으면(/auth/me 401) 로그인 화면으로 간다', async () => {
    mockApi({ 'GET /auth/me': () => ({ status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' } }) });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: '단말온 가맹점' })).toBeInTheDocument();
  });

  it('로그인하면 처음 화면으로 가고 위에 내 매장 이름이 보인다', async () => {
    const { calls } = mockApi({
      'GET /auth/me': () => ({ status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' } }),
      'POST /auth/login': () => ({ body: OWNER }),
      'GET /me/merchant': () => ({ body: STORE }),
    });
    renderApp('/');
    await userEvent.type(await screen.findByLabelText('아이디'), ' merchant-gangnam ');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByText('강남김밥')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/login')?.body).toEqual({ loginId: 'merchant-gangnam', password: 'pw' });
    expect(screen.getByRole('navigation', { name: '메뉴' })).toBeInTheDocument();
  });

  it('틀린 비밀번호는 점주 안내 문구로', async () => {
    mockApi({
      'GET /auth/me': () => ({ status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: 'x' } }),
      'POST /auth/login': () => ({ status: 401, body: { statusCode: 401, code: 'LOGIN_FAILED', message: '아이디 또는 비밀번호가 틀립니다.' } }),
    });
    renderApp('/login');
    await userEvent.type(await screen.findByLabelText('아이디'), 'merchant-gangnam');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('아이디 또는 비밀번호가 맞지 않습니다.');
  });

  it('사내 직원 계정이면 안내와 로그아웃만 — 매장 API를 부르지 않는다', async () => {
    const { calls } = mockApi({
      'GET /auth/me': () => ({ body: { loginId: 'operator', displayName: '운영자', role: 'OPERATOR', merchantCode: null } }),
      'POST /auth/logout': () => ({ status: 204 }),
    });
    renderApp('/');
    expect(await screen.findByText(/가맹점\(점주\) 계정용입니다/)).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith('/me'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    expect(await screen.findByRole('heading', { name: '단말온 가맹점' })).toBeInTheDocument();
    expect(getMe()).toBeNull();
  });

  it('매장 화면 요청이 401이면(세션 끝남) 로그인 화면으로', async () => {
    mockApi({
      'GET /auth/me': () => ({ body: OWNER }),
      'GET /me/merchant': () => ({ status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: '세션이 끝났습니다.' } }),
    });
    renderApp('/');
    await waitFor(() => expect(screen.getByRole('heading', { name: '단말온 가맹점' })).toBeInTheDocument());
  });
});
