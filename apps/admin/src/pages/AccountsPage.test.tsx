import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AccountView } from '@terminal-ops/contracts';
import { App } from '../App';
import { dashboardBody } from '../test/fixtures';
import { loginAs, mockApi, renderPage, type Call } from '../test/render';
import { AccountsPage } from './AccountsPage';

const account = (id: number, loginId: string, over: Partial<AccountView> = {}): AccountView => ({
  id,
  loginId,
  displayName: `${loginId} 이름`,
  role: 'OPERATOR',
  merchantCode: null,
  disabled: false,
  createdAt: '2026-10-28T00:00:00.000Z',
  lastLoginAt: null,
  ...over,
});

const MERCHANTS = {
  'GET /merchants': () => ({
    body: [
      { code: 'GANGNAM-KIMBAP', name: '강남김밥', address: '서울 강남구' },
      { code: 'YEOKSAM-CAFE', name: '역삼카페', address: '서울 강남구' },
    ],
  }),
};

/** 서버 흉내: 목록은 accounts 배열, PATCH는 준 것만 바꾼다 */
function accountsApi(initial: AccountView[], patch?: (c: Call) => { status?: number; body?: unknown } | undefined) {
  const accounts = [...initial];
  return mockApi({
    ...MERCHANTS,
    'GET /admin/accounts': () => ({ body: accounts }),
    'PATCH /admin/accounts/:id': (c) => {
      const custom = patch?.(c);
      if (custom) return custom;
      const id = Number(c.path.split('/').at(-1));
      const i = accounts.findIndex((a) => a.id === id);
      accounts[i] = { ...accounts[i], ...(c.body as Partial<AccountView>) };
      return { body: accounts[i] };
    },
    'POST /admin/accounts': (c) => {
      const body = c.body as { loginId: string; displayName: string; role: AccountView['role']; merchantCode: string | null };
      const created = account(accounts.length + 1, body.loginId, { displayName: body.displayName, role: body.role, merchantCode: body.merchantCode });
      accounts.push(created);
      return { status: 201, body: created };
    },
  });
}

const row = (loginId: string) => screen.getByRole('row', { name: `계정 ${loginId}` });

describe('계정 화면 (ADMIN, 보강 5)', () => {
  it('목록: 아이디·이름·역할·상태·마지막 로그인, 내 계정 표시, 외부 업체 키는 개발자센터 안내', async () => {
    accountsApi([account(1, 'admin', { role: 'ADMIN', lastLoginAt: '2026-10-29T00:00:00.000Z' }), account(2, 'gone', { disabled: true })]);
    loginAs('admin', 'ADMIN');
    renderPage(<AccountsPage />);
    expect(await screen.findByRole('row', { name: '계정 admin' })).toHaveTextContent('admin나admin 이름');
    expect(within(row('admin')).getByLabelText('역할')).toHaveValue('ADMIN');
    expect(row('admin')).toHaveTextContent('2026-10-29 09:00:00 KST');
    expect(row('gone')).toHaveTextContent('사용 중지');
    expect(within(row('gone')).getByRole('button', { name: '다시 사용' })).toBeInTheDocument();
    expect(screen.getByLabelText('외부 업체 키')).toHaveTextContent('개발자센터 화면(보강 7)');
  });

  it('만들기: 아이디 형식·비밀번호 길이를 미리 알리고, 가맹점주는 가맹점을 골라야 만든다. 보낸 뒤 목록을 다시 읽는다', async () => {
    const { calls } = accountsApi([account(1, 'admin', { role: 'ADMIN' })]);
    loginAs('admin', 'ADMIN');
    renderPage(<AccountsPage />);
    const form = screen.getByRole('form', { name: '계정 만들기' });
    await userEvent.type(within(form).getByLabelText('새 아이디'), 'a!');
    await userEvent.type(within(form).getByLabelText('처음 비밀번호'), 'short');
    expect(within(form).getByText('아이디는 영문·숫자·`.`·`-`·`_` 3~50자입니다.')).toBeInTheDocument();
    expect(within(form).getByText('비밀번호는 10~200자입니다.')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: '만들기' })).toBeDisabled();

    await userEvent.clear(within(form).getByLabelText('새 아이디'));
    await userEvent.type(within(form).getByLabelText('새 아이디'), 'owner-yeoksam');
    await userEvent.type(within(form).getByLabelText('표시 이름'), '역삼 점주');
    await userEvent.clear(within(form).getByLabelText('처음 비밀번호'));
    await userEvent.type(within(form).getByLabelText('처음 비밀번호'), 'demo-pass-0001');
    await userEvent.selectOptions(within(form).getByLabelText('새 역할'), 'MERCHANT');
    expect(within(form).getByText('가맹점주 계정은 가맹점을 골라야 합니다.')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: '만들기' })).toBeDisabled();
    await within(form).findByRole('option', { name: '역삼카페 (YEOKSAM-CAFE)' });
    await userEvent.selectOptions(within(form).getByLabelText('새 가맹점'), 'YEOKSAM-CAFE');
    const reads = calls.filter((c) => c.path === '/admin/accounts' && c.method === 'GET').length;
    await userEvent.click(within(form).getByRole('button', { name: '만들기' }));

    expect(await within(form).findByRole('status')).toHaveTextContent('owner-yeoksam 만듦 · 가맹점주');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      loginId: 'owner-yeoksam',
      displayName: '역삼 점주',
      password: 'demo-pass-0001',
      role: 'MERCHANT',
      merchantCode: 'YEOKSAM-CAFE',
    });
    expect(await screen.findByRole('row', { name: '계정 owner-yeoksam' })).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/admin/accounts' && c.method === 'GET').length).toBeGreaterThan(reads);
    expect(within(form).getByLabelText('처음 비밀번호')).toHaveValue('');
  });

  it('역할 바꾸기: 고르면 "역할 저장"이 보이고, 확인을 받고 PATCH. 가맹점주로 바꾸면 가맹점도 함께, 다른 역할은 merchantCode null', async () => {
    const { calls } = accountsApi([account(1, 'admin', { role: 'ADMIN' }), account(2, 'kim')]);
    loginAs('admin', 'ADMIN');
    renderPage(<AccountsPage />);
    await screen.findByRole('row', { name: '계정 kim' });
    expect(within(row('kim')).queryByRole('button', { name: '역할 저장' })).not.toBeInTheDocument();

    await userEvent.selectOptions(within(row('kim')).getByLabelText('역할'), 'MONITOR');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    await userEvent.click(within(row('kim')).getByRole('button', { name: '역할 저장' }));
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(confirm.mock.calls[0][0]).toContain('kim의 역할을 관제(으)로 바꿀까요? 그 계정의 로그인이 모두 끊깁니다.');
    await userEvent.click(within(row('kim')).getByRole('button', { name: '역할 저장' }));
    await waitFor(() => expect(within(row('kim')).getByLabelText('역할')).toHaveValue('MONITOR'));
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => [c.path, c.body])).toEqual([['/admin/accounts/2', { role: 'MONITOR', merchantCode: null }]]);
    await waitFor(() => expect(within(row('kim')).queryByRole('button', { name: '역할 저장' })).not.toBeInTheDocument());

    await userEvent.selectOptions(within(row('kim')).getByLabelText('역할'), 'MERCHANT');
    expect(within(row('kim')).getByRole('button', { name: '역할 저장' })).toBeDisabled(); // 가맹점을 고르기 전
    await within(row('kim')).findByRole('option', { name: '강남김밥 (GANGNAM-KIMBAP)' });
    await userEvent.selectOptions(within(row('kim')).getByLabelText('가맹점'), 'GANGNAM-KIMBAP');
    await userEvent.click(within(row('kim')).getByRole('button', { name: '역할 저장' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'PATCH')[1].body).toEqual({ role: 'MERCHANT', merchantCode: 'GANGNAM-KIMBAP' });
  });

  it('사용 중지는 확인을 받고 {disabled: true}, 다시 사용은 바로 {disabled: false}. 내 계정이면 확인 글에 다시 로그인 안내', async () => {
    const { calls } = accountsApi([account(1, 'admin', { role: 'ADMIN' }), account(2, 'kim')]);
    loginAs('admin', 'ADMIN');
    renderPage(<AccountsPage />);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.click(within(await screen.findByRole('row', { name: '계정 kim' })).getByRole('button', { name: '사용 중지' }));
    expect(await within(row('kim')).findByRole('button', { name: '다시 사용' })).toBeInTheDocument();
    expect(row('kim')).toHaveTextContent('사용 중지');
    await userEvent.click(within(row('kim')).getByRole('button', { name: '다시 사용' }));
    expect(await within(row('kim')).findByRole('button', { name: '사용 중지' })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ disabled: true }, { disabled: false }]);
    expect(confirm).toHaveBeenCalledTimes(1);

    confirm.mockReturnValueOnce(false);
    await userEvent.click(within(row('admin')).getByRole('button', { name: '사용 중지' }));
    expect(confirm.mock.calls[1][0]).toContain('내 계정입니다 — 저장하면 지금 세션이 끊겨 다시 로그인해야 합니다.');
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2);
  });

  it('마지막 활성 ADMIN을 내리면 409 LAST_ADMIN 안내를 보이고 고르던 역할을 서버 값으로 되돌린다', async () => {
    accountsApi([account(1, 'admin', { role: 'ADMIN' })], () => ({
      status: 409,
      body: { statusCode: 409, code: 'LAST_ADMIN', message: '마지막 활성 ADMIN은 사용 중지하거나 다른 역할로 바꿀 수 없습니다. 다른 ADMIN을 먼저 만드세요.' },
    }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    loginAs('admin', 'ADMIN');
    renderPage(<AccountsPage />);
    await userEvent.selectOptions(within(await screen.findByRole('row', { name: '계정 admin' })).getByLabelText('역할'), 'OPERATOR');
    await userEvent.click(within(row('admin')).getByRole('button', { name: '역할 저장' }));
    expect(await within(row('admin')).findByRole('alert')).toHaveTextContent('마지막 활성 ADMIN입니다. 다른 ADMIN 계정을 먼저 만들거나 살린 뒤 바꾸세요.');
    expect(within(row('admin')).getByLabelText('역할')).toHaveValue('ADMIN');
  });

  it('ADMIN 메뉴에 "계정"이 있고, 운영자가 주소로 열면 권한 안내만(계정 목록을 부르지 않는다)', async () => {
    const { calls } = mockApi({ 'GET /health': () => ({ body: { status: 'ok' } }), 'GET /dashboard/summary': () => ({ body: dashboardBody() }) });
    loginAs('admin', 'ADMIN');
    const admin = renderPage(<App />, { path: '/*' });
    expect(await within(screen.getByRole('navigation', { name: '메뉴' })).findByRole('link', { name: '계정' })).toHaveAttribute('href', '/admin/accounts');
    admin.unmount();

    loginAs('op', 'OPERATOR');
    renderPage(<App />, { path: '/*', route: '/admin/accounts' });
    expect(await screen.findByRole('alert')).toHaveTextContent('이 화면을 볼 권한이 없습니다');
    expect(within(screen.getByRole('navigation', { name: '메뉴' })).queryByRole('link', { name: '계정' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === '/admin/accounts')).toBe(false);
  });
});
