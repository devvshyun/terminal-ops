import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { MeView } from '@terminal-ops/contracts';
import { getMe } from './session';
import { partnersApi } from './test/fixtures';
import { ADMIN, mockApi, renderApp } from './test/render';

const UNAUTH = { status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' } };

describe('로그인 문과 화면 틀 (보강 7, decisions/0080)', () => {
  it('로그인 안 했으면(/auth/me 401) 로그인 화면으로 간다', async () => {
    mockApi({ 'GET /auth/me': () => UNAUTH });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: '단말온 개발자센터' })).toBeInTheDocument();
  });

  it('ADMIN으로 로그인하면 업체 화면으로 가고 위에 메뉴 셋이 보인다', async () => {
    const { calls } = mockApi({ 'GET /auth/me': () => UNAUTH, 'POST /auth/login': () => ({ body: ADMIN }), ...partnersApi() });
    renderApp('/');
    await userEvent.type(await screen.findByLabelText('아이디'), ' admin ');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByRole('heading', { name: '외부 업체' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/login')?.body).toEqual({ loginId: 'admin', password: 'pw' });
    const nav = screen.getByRole('navigation', { name: '메뉴' });
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['외부 업체', '호출 로그', '연동 문서']);
    expect(screen.getByText('관리자 (ADMIN)')).toBeInTheDocument();
  });

  it.each([
    ['관제', { loginId: 'monitor', displayName: '관제', role: 'MONITOR', merchantCode: null }],
    ['운영자', { loginId: 'operator', displayName: '운영자', role: 'OPERATOR', merchantCode: null }],
    ['가맹점주', { loginId: 'merchant-gangnam', displayName: '점주', role: 'MERCHANT', merchantCode: 'GANGNAM-KIMBAP' }],
  ] as [string, MeView][])('%s 계정이면 안내와 로그아웃만 — /admin API를 부르지 않는다', async (_name, me) => {
    const { calls } = mockApi({ 'GET /auth/me': () => ({ body: me }), 'POST /auth/logout': () => ({ status: 204 }) });
    renderApp('/');
    expect(await screen.findByText(/ADMIN 계정용입니다/)).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith('/admin'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    expect(await screen.findByRole('heading', { name: '단말온 개발자센터' })).toBeInTheDocument();
    expect(getMe()).toBeNull();
  });

  it('화면 요청이 401이면(세션 끝남) 로그인 화면으로', async () => {
    mockApi({ 'GET /auth/me': () => ({ body: ADMIN }), 'GET /admin/partners': () => UNAUTH });
    renderApp('/');
    await waitFor(() => expect(screen.getByRole('heading', { name: '단말온 개발자센터' })).toBeInTheDocument());
  });

  it('틀린 비밀번호는 안내 문구로', async () => {
    mockApi({
      'GET /auth/me': () => UNAUTH,
      'POST /auth/login': () => ({ status: 401, body: { statusCode: 401, code: 'LOGIN_FAILED', message: '아이디 또는 비밀번호가 틀립니다.' } }),
    });
    renderApp('/login');
    await userEvent.type(await screen.findByLabelText('아이디'), 'admin');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('아이디 또는 비밀번호가 맞지 않습니다.');
  });
});
