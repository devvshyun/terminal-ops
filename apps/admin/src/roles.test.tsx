import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Role, TerminalDetail } from '@terminal-ops/contracts';
import { App } from './App';
import { api } from './api/client';
import { getMe } from './session';
import { dashboardBody } from './test/fixtures';
import { loginAs, mockApi, renderPage } from './test/render';

const unauth = { status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: '세션이 끝났습니다' } };
const me = (loginId: string, role: Role = 'OPERATOR') => ({ loginId, displayName: loginId, role, merchantCode: null });

const terminal = (over: Partial<TerminalDetail> = {}): TerminalDetail => ({
  serialNo: 'AS-1',
  modelCode: 'SN-100',
  modelName: '유선 카운터형',
  merchantCode: null,
  merchantName: null,
  status: 'IN_STOCK',
  statusChangedAt: '2026-10-26T01:00:00.000Z',
  version: 1,
  createdAt: '2026-10-26T01:00:00.000Z',
  updatedAt: '2026-10-26T01:00:00.000Z',
  allowedTransitions: [{ to: 'DELIVERED', blockedReason: null }],
  actions: { allocate: true, cancelAllocation: true, ship: true, inspect: true },
  ...over,
});

const detailApi = () => ({
  'GET /terminals/AS-1': () => ({ body: terminal() }),
  'GET /terminals/AS-1/history': () => ({ body: [] }),
  'GET /terminals/AS-1/connectivity': () => ({ status: 403, body: { statusCode: 403, code: 'FORBIDDEN', message: 'OFFICE만' } }),
  'GET /terminals/AS-1/inspections': () => ({ body: [] }),
  'GET /inspection-items': () => ({ body: [{ code: 'POWER', label: '전원', sortOrder: 0 }] }),
  'GET /merchants': () => ({ status: 403, body: { statusCode: 403, code: 'FORBIDDEN', message: 'OFFICE만' } }),
});

describe('로그인한 사람이 바뀌면 화면 데이터 캐시를 비운다', () => {
  it('A가 본 /merchants(staleTime Infinity)가 401 뒤 B에게 보이지 않는다', async () => {
    let owner = 'A';
    mockApi({
      'GET /auth/me': () => ({ body: me('a') }),
      'GET /terminals': () => ({ body: { items: [], total: 0, page: 1, size: 20 } }),
      'GET /terminal-models': () => ({ body: [] }),
      'GET /merchants': () => ({ body: [{ code: `${owner}-CODE`, name: `${owner}의 가맹점`, address: '서울' }] }),
      // 세션 끝남(401)을 만드는 요청. 단말기 목록이 부르지 않는 것이어야 한다 — 목록은 상태 칩 때문에 /dashboard/summary를 부른다(decisions/0079)
      'GET /health': () => unauth,
      'GET /dashboard/summary': () => ({ body: dashboardBody() }),
      'POST /auth/login': () => {
        owner = 'B';
        return { body: me('b') };
      },
    });
    renderPage(<App />, { path: '/*', route: '/terminals' });
    expect(await screen.findByRole('option', { name: 'A의 가맹점' })).toBeInTheDocument();

    await api('/health').catch(() => undefined); // 세션 끝남(401)
    await userEvent.type(await screen.findByLabelText('아이디'), 'b');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'pw-1234567890');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));

    expect(await screen.findByRole('option', { name: 'B의 가맹점' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'A의 가맹점' })).not.toBeInTheDocument();
  });

  it('로그아웃해도 비우고, /login으로 가며 돌아올 주소(from)를 남기지 않는다', async () => {
    mockApi({
      'GET /health': () => ({ body: { status: 'ok' } }),
      'GET /dashboard/summary': () => ({ body: dashboardBody() }),
      'GET /terminals': () => ({ body: { items: [], total: 0, page: 1, size: 20 } }),
      'GET /terminal-models': () => ({ body: [] }),
      'GET /merchants': () => ({ body: [] }),
      'POST /auth/logout': () => ({ status: 204 }),
      'POST /auth/login': () => ({ body: me('b') }),
    });
    loginAs('김운영');
    const { client } = renderPage(<App />, { path: '/*', route: '/terminals' });
    await screen.findByText('총 0대');
    await userEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    expect(await screen.findByLabelText('아이디')).toBeInTheDocument();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    await userEvent.type(screen.getByLabelText('아이디'), 'b');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'pw-1234567890');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    // 로그아웃 전 화면(/terminals)이 아니라 처음 화면으로 들어온다
    await screen.findByRole('link', { name: '처음' });
    await waitFor(() => expect(screen.getByRole('link', { name: '처음' })).toHaveAttribute('aria-current', 'page'));
  });

  it('로그아웃 요청이 실패하면 안내를 보이고 로그인 상태를 유지한다', async () => {
    mockApi({
      'GET /health': () => ({ body: { status: 'ok' } }),
      'GET /dashboard/summary': () => ({ body: dashboardBody() }),
      'POST /auth/logout': () => ({ status: 500, body: { statusCode: 500, message: '서버 오류' } }),
    });
    loginAs('김운영');
    renderPage(<App />, { path: '/*' });
    await userEvent.click(await screen.findByRole('button', { name: '로그아웃' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('로그아웃하지 못했습니다');
    expect(getMe()).toMatchObject({ loginId: '김운영' });
    expect(screen.getByRole('button', { name: '로그아웃' })).toBeEnabled();
  });
});

describe('역할별 단말기 상세', () => {
  const open = (role: Role) => {
    const { calls } = mockApi(detailApi());
    loginAs('u', role);
    renderPage(<App />, { path: '/*', route: '/terminals/AS-1' });
    return calls;
  };

  it('OPERATOR: 전이·배정·취소·출고·검수 모두, 접속 상태 조회', async () => {
    const calls = mockApi({ ...detailApi(), 'GET /terminals/AS-1/connectivity': () => ({ body: { serialNo: 'AS-1', source: 'none', online: false, lastSeenAt: null, firmwareVersion: null } }), 'GET /merchants': () => ({ body: [] }) }).calls;
    loginAs('u', 'OPERATOR');
    renderPage(<App />, { path: '/*', route: '/terminals/AS-1' });
    expect(await screen.findByRole('button', { name: '→ 배송 완료' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '가맹점 배정' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '배정 취소' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '출고(운송장 발급)' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '검수 결과 저장' })).toBeInTheDocument();
    expect(await screen.findByText('하트비트 기록이 없습니다.')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/merchants')).toBe(true);
  });

  it('FIELD: 검수만. 가맹점·접속 상태는 부르지 않고 403 상자도 없다', async () => {
    const calls = open('FIELD');
    expect(await screen.findByRole('button', { name: '검수 결과 저장' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '→ 배송 완료' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '가맹점 배정' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '배정 취소' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '출고(운송장 발급)' })).not.toBeInTheDocument();
    expect(screen.queryByText('접속 상태')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === '/merchants' || c.path.endsWith('/connectivity'))).toBe(false);
  });

  it.each(['MONITOR', 'ADMIN'] as const)('%s: 읽기만 — 할 수 있는 일 패널이 없고 가맹점은 부르지 않는다(접속 상태는 본다)', async (role) => {
    const calls = mockApi({ ...detailApi(), 'GET /terminals/AS-1/connectivity': () => ({ body: { serialNo: 'AS-1', source: 'none', online: false, lastSeenAt: null, firmwareVersion: null } }) }).calls;
    loginAs('u', role);
    renderPage(<App />, { path: '/*', route: '/terminals/AS-1' });
    expect(await screen.findByText('하트비트 기록이 없습니다.')).toBeInTheDocument();
    expect(screen.queryByText('할 수 있는 일')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '→ 배송 완료' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '검수 결과 저장' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === '/merchants' || c.path === '/inspection-items')).toBe(false);
  });
});

describe('단말기 목록 — 가맹점 필터는 사무실 역할만', () => {
  const list = (role: Role) => {
    const { calls } = mockApi({
      'GET /terminals': () => ({ body: { items: [], total: 0, page: 1, size: 20 } }),
      'GET /terminal-models': () => ({ body: [] }),
      'GET /merchants': () => ({ status: 403, body: { statusCode: 403, code: 'FORBIDDEN', message: 'OFFICE만' } }),
    });
    loginAs('u', role);
    renderPage(<App />, { path: '/*', route: '/terminals' });
    return calls;
  };

  it('FIELD는 /merchants를 부르지 않고 가맹점 선택칸도 없다', async () => {
    const calls = list('FIELD');
    await screen.findByText('총 0대');
    expect(calls.some((c) => c.path === '/merchants')).toBe(false);
    expect(screen.queryByLabelText('가맹점')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('MONITOR는 부른다', async () => {
    const calls = list('MONITOR');
    await screen.findByText('총 0대');
    expect(calls.some((c) => c.path === '/merchants')).toBe(true);
  });
});

describe('화면 경로 역할 검사·/login', () => {
  it('주소로 직접 들어가도 권한이 없으면 403 안내(폼을 열지 않는다)', async () => {
    const { calls } = mockApi({});
    loginAs('u', 'MONITOR');
    renderPage(<App />, { path: '/*', route: '/scans' });
    expect(await screen.findByRole('alert')).toHaveTextContent('이 화면을 볼 권한이 없습니다');
    expect(screen.queryByRole('heading', { name: '박스 스캔' })).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('FIELD가 사무실 화면(리포트)을 직접 열어도 막힌다', async () => {
    mockApi({});
    loginAs('u', 'FIELD');
    renderPage(<App />, { path: '/*', route: '/reports/van/3' });
    expect(await screen.findByRole('alert')).toHaveTextContent('이 화면을 볼 권한이 없습니다');
  });

  it('이미 로그인했으면 /login은 처음 화면으로 보낸다(세션을 서버에 묻고)', async () => {
    mockApi({
      'GET /auth/me': () => ({ body: me('a') }),
      'GET /health': () => ({ body: { status: 'ok' } }),
      'GET /dashboard/summary': () => ({ body: dashboardBody() }),
    });
    renderPage(<App />, { path: '/*', route: '/login' });
    expect(await screen.findByRole('button', { name: '로그아웃' })).toBeInTheDocument();
    expect(screen.queryByLabelText('아이디')).not.toBeInTheDocument();
  });
});
