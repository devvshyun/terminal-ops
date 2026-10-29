import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreatedPartnerKeyView } from '@terminal-ops/contracts';
import { call, callPage, minutesAgo, partner, partnerKey, partnersApi } from '../test/fixtures';
import { loginAs, mockApi, renderApp } from '../test/render';

const RAW = 'pk_a1b2c3d4_' + 'x'.repeat(43);

const detailApi = (over: Record<string, () => { status?: number; body?: unknown }> = {}) => ({
  ...partnersApi(),
  'GET /admin/partner-keys': () => ({
    body: [
      partnerKey(),
      partnerKey({ id: 12, name: '옛 키', prefix: 'pk_old00001', revokedAt: minutesAgo(60), lastUsedAt: null }),
      partnerKey({ id: 13, name: '시험 키', prefix: 'pk_exp00001', expiresAt: minutesAgo(1), scopes: ['terminal-status:read', 'merchant-terminals:read'] }),
    ],
  }),
  'GET /admin/partner-calls': () => ({ body: callPage([call(), call({ id: 99, status: 403, path: '/partner/v1/merchants/GANGNAM-KIMBAP/terminals' })]) }),
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('업체 화면 — 키 발급·폐기·최근 호출 (보강 7)', () => {
  it('업체 이름·코드·메모, 키 표(상태: 사용 중·폐기됨·만료됨), 이 업체의 최근 호출', async () => {
    const { calls } = mockApi(detailApi());
    loginAs();
    renderApp('/partners/1');
    expect(await screen.findByRole('heading', { name: '한올POS' })).toBeInTheDocument();
    expect(screen.getByText('HANOL-POS')).toBeInTheDocument();
    expect(screen.getByText('가맹점 POS 연동')).toBeInTheDocument();
    const keys = await screen.findByRole('table', { name: '키 목록' });
    const rows = within(keys).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual(['pk_a1b2c3d4', 'pk_old00001', 'pk_exp00001']);
    expect(rows[0]).toHaveTextContent('사용 중');
    expect(rows[1]).toHaveTextContent('폐기됨');
    expect(rows[2]).toHaveTextContent('만료됨');
    expect(rows[2]).toHaveTextContent('단말기 상태 · 가맹점 단말기 목록');
    // 폐기 단추는 사용 중인 키에만
    expect(within(rows[0]).getByRole('button', { name: '폐기' })).toBeInTheDocument();
    expect(within(rows[1]).queryByRole('button', { name: '폐기' })).not.toBeInTheDocument();
    const recent = await screen.findByRole('table', { name: '최근 호출' });
    expect(within(recent).getAllByRole('row')).toHaveLength(3);
    expect(calls.find((c) => c.path === '/admin/partner-keys')?.query.get('partnerId')).toBe('1');
    expect(Object.fromEntries(calls.find((c) => c.path === '/admin/partner-calls')!.query)).toEqual({ partnerId: '1', limit: '20' });
  });

  it('발급: 이름표·범위 고르기 → POST, 원문은 한 번만 보이고 복사할 수 있다. 확인을 누르면 사라진다', async () => {
    const created: CreatedPartnerKeyView = { ...partnerKey({ id: 14, name: '정산 서버', prefix: 'pk_a1b2c3d4', lastUsedAt: null }), key: RAW };
    const { calls } = mockApi(detailApi({ 'POST /admin/partner-keys': () => ({ status: 201, body: created }) }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    loginAs();
    renderApp('/partners/1');
    await userEvent.type(await screen.findByLabelText('키 이름표'), '정산 서버');
    await userEvent.click(screen.getByRole('checkbox', { name: /가맹점 단말기 목록/ }));
    await userEvent.click(screen.getByRole('button', { name: '키 발급' }));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ partnerId: 1, name: '정산 서버', scopes: ['terminal-status:read', 'merchant-terminals:read'], expiresAt: null });
    const box = await screen.findByRole('region', { name: '새 키' });
    expect(within(box).getByText(RAW)).toBeInTheDocument();
    expect(box).toHaveTextContent('다시 볼 수 없습니다');
    await userEvent.click(within(box).getByRole('button', { name: '복사' }));
    expect(writeText).toHaveBeenCalledWith(RAW);
    expect(await within(box).findByText('복사했습니다')).toBeInTheDocument();
    await userEvent.click(within(box).getByRole('button', { name: '보관했습니다' }));
    expect(screen.queryByRole('region', { name: '새 키' })).not.toBeInTheDocument();
    expect(screen.queryByText(RAW)).not.toBeInTheDocument();
    // 다음 키는 다시 가장 좁은 범위에서 시작한다(앞 키의 넓은 범위를 실수로 물려받지 않게)
    expect(screen.getByRole('checkbox', { name: /가맹점 단말기 목록/ })).not.toBeChecked();
    expect(screen.getByLabelText('키 이름표')).toHaveValue('');
  });

  it('범위를 하나도 고르지 않으면 발급 단추가 꺼진다. 만료일을 고르면 그날 끝(KST 23:59:59)으로 보낸다', async () => {
    const { calls } = mockApi(detailApi({ 'POST /admin/partner-keys': () => ({ status: 201, body: { ...partnerKey(), key: RAW } }) }));
    loginAs();
    renderApp('/partners/1');
    await userEvent.type(await screen.findByLabelText('키 이름표'), '임시');
    await userEvent.click(screen.getByRole('checkbox', { name: /단말기 상태/ }));
    expect(screen.getByRole('button', { name: '키 발급' })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /단말기 상태/ }));
    await userEvent.type(screen.getByLabelText('만료일(선택)'), '2027-01-31');
    await userEvent.click(screen.getByRole('button', { name: '키 발급' }));
    expect((calls.find((c) => c.method === 'POST')?.body as { expiresAt: string }).expiresAt).toBe('2027-01-31T14:59:59.000Z');
  });

  it('폐기는 확인을 받는다 — 취소하면 부르지 않고, 확인하면 POST …/revoke', async () => {
    const { calls } = mockApi(detailApi({ 'POST /admin/partner-keys/:id/revoke': () => ({ body: partnerKey({ revokedAt: new Date().toISOString() }) }) }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    loginAs();
    renderApp('/partners/1');
    const keys = await screen.findByRole('table', { name: '키 목록' });
    await userEvent.click(within(keys).getByRole('button', { name: '폐기' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(confirm.mock.calls[0][0]).toContain('pk_a1b2c3d4');
    await userEvent.click(within(keys).getByRole('button', { name: '폐기' }));
    expect(calls.find((c) => c.method === 'POST')?.path).toBe('/admin/partner-keys/11/revoke');
  });

  it('없는 업체 번호는 안내', async () => {
    mockApi(detailApi());
    loginAs();
    renderApp('/partners/99');
    expect(await screen.findByText('없는 업체입니다.')).toBeInTheDocument();
  });
});
