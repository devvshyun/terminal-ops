import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { api } from './api/client';
import { getMe } from './session';
import { mockApi, OWNER, renderApp } from './test/render';

/** 홈 화면(HomePage)이 부르는 두 목록의 빈 응답 — 홈이 그려지는 테스트에서 404 오류 상자가 끼어들지 않게 */
const HOME_EMPTY = {
  'GET /me/terminals': () => ({ body: { items: [], total: 0, page: 1, size: 100 } }),
  'GET /me/service-tickets': () => ({ body: { items: [], nextBeforeId: null } }),
};

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

/**
 * 사용자 전환·로그아웃 안전장치(어드민 roles.test와 같은 규칙, 리뷰 반영). 아래 테스트는 구현이 이미 있어 처음부터 통과했다 —
 * 새 동작을 만든 것이 아니라 회귀 방지(regression guard)다.
 */
describe('사용자 전환과 로그아웃 (회귀 방지)', () => {
  const UNAUTH = { status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: '세션이 끝났습니다.' } };
  const OWNER_B = { ...OWNER, loginId: 'merchant-yeoksam', displayName: '역삼카페 점주', merchantCode: 'YEOKSAM-CAFE' };

  it('점주 A의 매장 이름(staleTime 무한)이 세션 401 뒤 점주 B 로그인에서 B 것으로 바뀐다', async () => {
    let loggedIn: 'A' | 'B' = 'A';
    let expired = false;
    mockApi({
      'GET /auth/me': () => ({ body: OWNER }),
      'GET /me/merchant': () => ({ body: loggedIn === 'A' ? STORE : { code: 'YEOKSAM-CAFE', name: '역삼카페', address: '서울 강남구 역삼동' } }),
      ...HOME_EMPTY,
      'GET /me/terminals': () => (expired ? UNAUTH : { body: { items: [], total: 0, page: 1, size: 100 } }),
      'POST /auth/login': () => ({ body: OWNER_B }),
    });
    renderApp('/');
    expect(await screen.findByText('강남김밥')).toBeInTheDocument();

    // 세션이 끝난 뒤의 401 → 로그인 화면(캐시는 비워짐)
    expired = true;
    await expect(api('/me/terminals')).rejects.toThrow();
    await userEvent.type(await screen.findByLabelText('아이디'), 'merchant-yeoksam');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'pw');
    loggedIn = 'B';
    expired = false; // 새 세션
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByText('역삼카페')).toBeInTheDocument();
    expect(screen.queryByText('강남김밥')).not.toBeInTheDocument();
  });

  it('로그아웃 요청이 실패(500)하면 안내를 보이고 로그인 상태를 유지한다', async () => {
    mockApi({
      'GET /auth/me': () => ({ body: OWNER }),
      'GET /me/merchant': () => ({ body: STORE }),
      ...HOME_EMPTY,
      'POST /auth/logout': () => ({ status: 500, body: { statusCode: 500, message: '서버 오류' } }),
    });
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: '로그아웃' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('로그아웃하지 못했습니다. 로그인 상태가 그대로입니다.');
    expect(getMe()).toMatchObject({ loginId: 'merchant-gangnam' });
    expect(screen.getByRole('button', { name: '로그아웃' })).toBeEnabled();
  });

  it('로그인 상태로 /login을 열면 홈으로, 일부러 로그아웃하면 돌아올 주소(from)를 남기지 않는다', async () => {
    mockApi({
      'GET /auth/me': () => ({ body: OWNER }),
      'GET /me/merchant': () => ({ body: STORE }),
      ...HOME_EMPTY,
      'POST /auth/logout': () => ({ status: 204 }),
      'POST /auth/login': () => ({ body: OWNER }),
    });
    const first = renderApp('/login');
    expect(await screen.findByRole('link', { name: '홈' })).toHaveAttribute('aria-current', 'page');
    first.unmount();

    renderApp('/no/such/page');
    expect(await screen.findByText('없는 화면입니다.')).toBeInTheDocument(); // 깊은 주소에서 시작
    await userEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    await userEvent.type(await screen.findByLabelText('아이디'), 'merchant-gangnam');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByRole('link', { name: '홈' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText('없는 화면입니다.')).not.toBeInTheDocument();
  });
});
