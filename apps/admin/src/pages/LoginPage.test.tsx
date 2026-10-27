import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { ErrorBox } from '../components/ErrorBox';
import { ApiError } from '../api/client';
import { getMe } from '../session';
import { dashboardBody } from '../test/fixtures';
import { loginAs, mockApi, renderPage } from '../test/render';

const HOME = { 'GET /health': () => ({ body: { status: 'ok' } }), 'GET /dashboard/summary': () => ({ body: dashboardBody() }) };
const ME_401 = { 'GET /auth/me': () => ({ status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: '로그인이 필요합니다' } }) };

async function fillLogin(id: string, pw: string) {
  await userEvent.type(await screen.findByLabelText('아이디'), id);
  await userEvent.type(screen.getByLabelText('비밀번호'), pw);
  await userEvent.click(screen.getByRole('button', { name: '로그인' }));
}

describe('로그인·로그아웃 (보강 2, api decisions/0050)', () => {
  it('세션이 없으면(/auth/me 401) 로그인 화면 → 로그인하면 가려던 화면으로 돌아간다', async () => {
    const { calls } = mockApi({
      ...ME_401,
      ...HOME,
      'GET /terminals': () => ({ body: { items: [], total: 0, page: 1, size: 20 } }),
      'GET /terminal-models': () => ({ body: [] }),
      'POST /auth/login': () => ({ body: { loginId: 'op1', displayName: '운영 1', role: 'OPERATOR', merchantCode: null } }),
    });
    renderPage(<App />, { path: '/*', route: '/terminals' });
    await fillLogin('op1', 'pw-1234567890');
    expect(calls.find((c) => c.path === '/auth/login')?.body).toEqual({ loginId: 'op1', password: 'pw-1234567890' });
    expect(await screen.findByRole('heading', { name: '단말기' })).toBeInTheDocument();
    expect(screen.getByText('운영 1')).toBeInTheDocument();
    expect(getMe()).toMatchObject({ loginId: 'op1', role: 'OPERATOR' });
  });

  it('틀리면 LOGIN_FAILED 안내, 잠기면 LOGIN_LOCKED 안내 — 로그인 화면에 남는다', async () => {
    let locked = false;
    mockApi({
      ...ME_401,
      'POST /auth/login': () =>
        locked
          ? { status: 429, body: { statusCode: 429, code: 'LOGIN_LOCKED', message: '잠시 막았습니다' } }
          : { status: 401, body: { statusCode: 401, code: 'LOGIN_FAILED', message: '아이디 또는 비밀번호가 맞지 않습니다.' } },
    });
    renderPage(<App />, { path: '/*' });
    await fillLogin('op1', 'wrong-password');
    expect(await screen.findByRole('alert')).toHaveTextContent('LOGIN_FAILED');
    locked = true;
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByText(/잠시 막혔습니다/)).toBeInTheDocument();
    expect(getMe()).toBeNull();
  });

  it('로그아웃하면 POST /auth/logout 뒤 로그인 화면', async () => {
    const { calls } = mockApi({ ...HOME, 'POST /auth/logout': () => ({ status: 204 }) });
    loginAs('김운영');
    renderPage(<App />, { path: '/*' });
    await userEvent.click(await screen.findByRole('button', { name: '로그아웃' }));
    expect(await screen.findByLabelText('아이디')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/auth/logout')).toBe(true);
    expect(getMe()).toBeNull();
  });

  it('쓰는 중에 세션이 끝나면(401) 로그인 화면으로 간다', async () => {
    mockApi({
      'GET /health': () => ({ body: { status: 'ok' } }),
      'GET /dashboard/summary': () => ({ status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: '세션이 끝났습니다' } }),
    });
    loginAs('김운영');
    renderPage(<App />, { path: '/*' });
    expect(await screen.findByLabelText('아이디')).toBeInTheDocument();
  });

  it('현장 작업자는 처음 화면 대신 박스 스캔, 메뉴는 단말기·박스 스캔 둘', async () => {
    mockApi({ 'GET /purchase-orders': () => ({ body: { items: [], nextBeforeId: null } }) });
    loginAs('현장1', 'FIELD');
    renderPage(<App />, { path: '/*' });
    expect(await screen.findByRole('heading', { name: '박스 스캔' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: '메뉴' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['단말기', '박스 스캔']);
  });

  it('가맹점주는 사내 어드민 대신 안내와 로그아웃만', async () => {
    mockApi({});
    loginAs('점주1', 'MERCHANT', 'GANGNAM-KIMBAP');
    renderPage(<App />, { path: '/*' });
    expect(await screen.findByText(/가맹점 계정은 사내 운영 어드민을 쓰지 않습니다/)).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: '메뉴' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '로그아웃' })).toBeInTheDocument();
  });

  it('403 FORBIDDEN은 권한 안내', () => {
    renderPage(<ErrorBox error={new ApiError(403, 'FORBIDDEN', '이 작업은 OPERATOR 역할만 할 수 있습니다(지금: MONITOR).', null)} />);
    expect(screen.getByRole('alert')).toHaveTextContent('이 작업을 할 권한이 없습니다');
    expect(screen.getByRole('alert')).toHaveTextContent('FORBIDDEN');
  });
});
