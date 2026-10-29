import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { MeView } from '@terminal-ops/contracts';
import { getMe } from './session';
import { dashboardApi } from './test/fixtures';
import { ADMIN, MONITOR, mockApi, renderApp } from './test/render';

const UNAUTH = { status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' } };

describe('로그인 문과 화면 틀 (보강 6, decisions/0074)', () => {
  it('로그인 안 했으면(/auth/me 401) 로그인 화면으로 간다', async () => {
    mockApi({ 'GET /auth/me': () => UNAUTH });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: '단말온 운영 관제' })).toBeInTheDocument();
  });

  it('관제로 로그인하면 대시보드로 가고 위에 메뉴 다섯과 자동 새로고침 단추가 보인다', async () => {
    const { calls } = mockApi({ 'GET /auth/me': () => UNAUTH, 'POST /auth/login': () => ({ body: MONITOR }), ...dashboardApi() });
    renderApp('/');
    await userEvent.type(await screen.findByLabelText('아이디'), ' monitor ');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByRole('heading', { name: '대시보드' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/login')?.body).toEqual({ loginId: 'monitor', password: 'pw' });
    const nav = screen.getByRole('navigation', { name: '메뉴' });
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['대시보드', '실패 job', '주기 작업', '최근 오류', '작업 기록']);
    expect(screen.getByRole('button', { name: '자동 새로고침 10초 · 켜짐' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('관제 담당 (관제)')).toBeInTheDocument();
  });

  it('ADMIN도 들어온다(보기)', async () => {
    mockApi({ 'GET /auth/me': () => ({ body: ADMIN }), ...dashboardApi() });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: '대시보드' })).toBeInTheDocument();
    expect(screen.getByText('관리자 (ADMIN)')).toBeInTheDocument();
  });

  it.each([
    ['운영자', { loginId: 'operator', displayName: '운영자', role: 'OPERATOR', merchantCode: null }],
    ['현장 작업자', { loginId: 'field', displayName: '현장', role: 'FIELD', merchantCode: null }],
    ['가맹점주', { loginId: 'merchant-gangnam', displayName: '점주', role: 'MERCHANT', merchantCode: 'GANGNAM-KIMBAP' }],
  ] as [string, MeView][])('%s 계정이면 안내와 로그아웃만 — 관제 API를 부르지 않는다', async (_name, me) => {
    const { calls } = mockApi({ 'GET /auth/me': () => ({ body: me }), 'POST /auth/logout': () => ({ status: 204 }) });
    renderApp('/');
    expect(await screen.findByText(/관제·ADMIN 계정용입니다/)).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith('/ops'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    expect(await screen.findByRole('heading', { name: '단말온 운영 관제' })).toBeInTheDocument();
    expect(getMe()).toBeNull();
  });

  it('화면 요청이 401이면(세션 끝남) 로그인 화면으로', async () => {
    mockApi({ 'GET /auth/me': () => ({ body: MONITOR }), 'GET /ops/queues': () => UNAUTH, 'GET /ops/system': () => UNAUTH, 'GET /ops/outbox': () => UNAUTH });
    renderApp('/');
    await waitFor(() => expect(screen.getByRole('heading', { name: '단말온 운영 관제' })).toBeInTheDocument());
  });

  it('틀린 비밀번호는 안내 문구로', async () => {
    mockApi({
      'GET /auth/me': () => UNAUTH,
      'POST /auth/login': () => ({ status: 401, body: { statusCode: 401, code: 'LOGIN_FAILED', message: '아이디 또는 비밀번호가 틀립니다.' } }),
    });
    renderApp('/login');
    await userEvent.type(await screen.findByLabelText('아이디'), 'monitor');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('아이디 또는 비밀번호가 맞지 않습니다.');
  });
});
