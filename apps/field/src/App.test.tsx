import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { FieldTodayView, MeView } from '@terminal-ops/contracts';
import { api } from './api/client';
import { getMe } from './session';
import { mockApi, renderApp, WORKER } from './test/render';

const UNAUTH = { status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' } };

const today = (over: Partial<FieldTodayView['scans']> = {}, inspections: FieldTodayView['inspections'] = { total: 0, passed: 0, failed: 0 }): FieldTodayView => ({
  date: '2026-10-28',
  scans: { boxes: 0, received: 0, returned: 0, rejected: 0, ...over },
  inspections,
});

describe('로그인 문과 화면 틀 (보강 4, decisions/0061)', () => {
  it('로그인 안 했으면(/auth/me 401) 로그인 화면으로 간다', async () => {
    mockApi({ 'GET /auth/me': () => UNAUTH });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: '단말온 현장' })).toBeInTheDocument();
  });

  it('로그인하면 처음 화면(오늘 내 작업)으로 가고 아래에 메뉴 셋이 보인다', async () => {
    const { calls } = mockApi({
      'GET /auth/me': () => UNAUTH,
      'POST /auth/login': () => ({ body: WORKER }),
      'GET /field/today': () => ({ body: today() }),
    });
    renderApp('/');
    await userEvent.type(await screen.findByLabelText('아이디'), ' field ');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByRole('heading', { name: '오늘 내 작업' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/login')?.body).toEqual({ loginId: 'field', password: 'pw' });
    const nav = screen.getByRole('navigation', { name: '메뉴' });
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['홈', '박스 스캔', '검수']);
  });

  it('오늘 요약은 서버가 센 수를 그대로 보여 주고, 큰 버튼 둘로 스캔·검수에 간다', async () => {
    mockApi({
      'GET /auth/me': () => ({ body: WORKER }),
      'GET /field/today': () => ({ body: today({ boxes: 3, received: 40, returned: 2, rejected: 1 }, { total: 5, passed: 4, failed: 1 }) }),
    });
    renderApp('/');
    expect(await screen.findByText('3개')).toBeInTheDocument();
    expect(screen.getByText('40대')).toBeInTheDocument();
    expect(screen.getByText('2대')).toBeInTheDocument();
    expect(screen.getByText('5대')).toBeInTheDocument();
    expect(screen.getByText(/검수 합격 4 · 불합격 1 · 거절된 줄 1/)).toBeInTheDocument();
    expect(screen.getByText('2026-10-28 (KST 0시부터)')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: '박스 스캔' }).map((a) => a.getAttribute('href'))).toEqual(['/scan', '/scan']);
  });

  it.each([
    ['운영자', { loginId: 'operator', displayName: '운영자', role: 'OPERATOR', merchantCode: null }],
    ['가맹점주', { loginId: 'merchant-gangnam', displayName: '점주', role: 'MERCHANT', merchantCode: 'GANGNAM-KIMBAP' }],
  ] as [string, MeView][])('%s 계정이면 안내와 로그아웃만 — 현장 API를 부르지 않는다', async (_name, me) => {
    const { calls } = mockApi({ 'GET /auth/me': () => ({ body: me }), 'POST /auth/logout': () => ({ status: 204 }) });
    renderApp('/');
    expect(await screen.findByText(/현장 작업자 계정용입니다/)).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith('/field'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    expect(await screen.findByRole('heading', { name: '단말온 현장' })).toBeInTheDocument();
    expect(getMe()).toBeNull();
  });

  it('화면 요청이 401이면(세션 끝남) 로그인 화면으로', async () => {
    mockApi({ 'GET /auth/me': () => ({ body: WORKER }), 'GET /field/today': () => UNAUTH });
    renderApp('/');
    await waitFor(() => expect(screen.getByRole('heading', { name: '단말온 현장' })).toBeInTheDocument());
  });
});

/**
 * 로그인·로그아웃 안전장치(점주 앱 App.test와 같은 세 테스트, Task 2 리뷰 반영). 구현(LoginPage·LogoutButton 사본·AuthGate)이 이미 있어
 * 처음부터 통과했다 — 새 동작이 아니라 회귀 방지(regression guard)다.
 */
describe('로그인과 로그아웃 (회귀 방지)', () => {
  const HOME = { 'GET /auth/me': () => ({ body: WORKER }), 'GET /field/today': () => ({ body: today() }) };

  it('틀린 비밀번호는 현장 안내 문구로', async () => {
    mockApi({
      'GET /auth/me': () => UNAUTH,
      'POST /auth/login': () => ({ status: 401, body: { statusCode: 401, code: 'LOGIN_FAILED', message: '아이디 또는 비밀번호가 틀립니다.' } }),
    });
    renderApp('/login');
    await userEvent.type(await screen.findByLabelText('아이디'), 'field');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('아이디 또는 비밀번호가 맞지 않습니다.');
  });

  it('로그아웃 요청이 실패(500)하면 안내를 보이고 로그인 상태를 유지한다', async () => {
    mockApi({ ...HOME, 'POST /auth/logout': () => ({ status: 500, body: { statusCode: 500, message: '서버 오류' } }) });
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: '로그아웃' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('로그아웃하지 못했습니다. 로그인 상태가 그대로입니다.');
    expect(screen.getByRole('alert')).toHaveTextContent('(서버 오류)');
    expect(getMe()).toMatchObject({ loginId: 'field' });
    expect(screen.getByRole('button', { name: '로그아웃' })).toBeEnabled();
  });

  it('로그인 상태로 /login을 열면 홈으로, 일부러 로그아웃하면 돌아올 주소(from)를 남기지 않는다', async () => {
    mockApi({ ...HOME, 'POST /auth/logout': () => ({ status: 204 }), 'POST /auth/login': () => ({ body: WORKER }) });
    const first = renderApp('/login');
    expect(await screen.findByRole('link', { name: '홈' })).toHaveAttribute('aria-current', 'page');
    first.unmount();

    renderApp('/no-such/deep/path');
    expect(await screen.findByText('없는 화면입니다.')).toBeInTheDocument(); // 깊은 주소에서 시작
    await userEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    await userEvent.type(await screen.findByLabelText('아이디'), 'field');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByRole('link', { name: '홈' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText('없는 화면입니다.')).not.toBeInTheDocument();
  });
});

/** 사용자 전환 안전장치(점주 앱 App.test와 같은 규칙) — 구현은 사본(session·SessionCacheSync)이라 처음부터 통과한다(회귀 방지) */
describe('사용자 전환 (회귀 방지)', () => {
  it('작업자 A의 오늘 요약이 세션 401 뒤 작업자 B 로그인에서 B 것으로 바뀐다', async () => {
    let who: 'A' | 'B' = 'A';
    let expired = false;
    mockApi({
      'GET /auth/me': () => ({ body: WORKER }),
      'GET /field/today': () => (expired ? UNAUTH : { body: today({ boxes: who === 'A' ? 7 : 2 }) }),
      'POST /auth/login': () => ({ body: { ...WORKER, loginId: 'field-b', displayName: '작업자 B' } }),
    });
    renderApp('/');
    expect(await screen.findByText('7개')).toBeInTheDocument();
    expired = true;
    await expect(api('/field/today')).rejects.toThrow();
    await userEvent.type(await screen.findByLabelText('아이디'), 'field-b');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'pw');
    who = 'B';
    expired = false;
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByText('2개')).toBeInTheDocument();
    expect(screen.queryByText('7개')).not.toBeInTheDocument();
    expect(screen.getByText('작업자 B')).toBeInTheDocument();
  });
});
