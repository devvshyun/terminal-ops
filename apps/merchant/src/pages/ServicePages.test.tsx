import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { composeSymptom, memoMax } from '../lib/symptom';
import { keyset, page, terminal, ticket } from '../test/fixtures';
import { loginAs, mockApi, renderPage } from '../test/render';
import { NewTicketPage } from './NewTicketPage';
import { ServiceTicketDetailPage } from './ServiceTicketDetailPage';
import { ServiceTicketsPage } from './ServiceTicketsPage';

describe('증상 글 (decisions/0060)', () => {
  it('고른 증상 + 메모를 "증상: 메모"로, 메모가 비면 증상만. 합쳐 200자를 넘지 않게 메모 길이를 줄인다', () => {
    expect(composeSymptom('카드 인식 안 됨', '  오전부터 ')).toBe('카드 인식 안 됨: 오전부터');
    expect(composeSymptom('기타', '   ')).toBe('기타');
    expect('기타'.length + 2 + memoMax('기타')).toBe(200);
  });
});

describe('A/S 목록', () => {
  it('최근 것 위에 상태 이름표, 진행 중이면 지금 단계. 위에 고장 접수 링크', async () => {
    loginAs();
    mockApi({
      'GET /me/service-tickets': () => ({ body: keyset([ticket({ remoteChecked: true }), ticket({ id: 3, status: 'RESOLVED_REMOTELY' })]) }),
    });
    renderPage(<ServiceTicketsPage />, { route: '/service-tickets', path: '/service-tickets' });
    const first = await screen.findByRole('link', { name: /A\/S #7/ });
    expect(first).toHaveAttribute('href', '/service-tickets/7');
    expect(within(first).getByText('확인 중')).toBeInTheDocument();
    expect(within(first).getByText('지금 단계: 교체 출고')).toBeInTheDocument();
    expect(within(screen.getByRole('link', { name: /A\/S #3/ })).getByText('원격으로 해결')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /고장 접수하기/ })).toHaveAttribute('href', '/service-tickets/new');
  });
});

describe('고장 접수', () => {
  const terminals = page([terminal(), terminal({ serialNo: 'SN-0101', status: 'SHIPPED', connectivity: null })]);
  const renderNew = (route = '/service-tickets/new') => renderPage(<NewTicketPage />, { route, path: '/service-tickets/new' });

  it('단말기 상세에서 오면 그 단말기가 골라져 있고, 사용 중인 단말기만 고를 수 있다. 증상을 골라야 접수 버튼이 켜진다', async () => {
    loginAs();
    const { calls } = mockApi({
      'GET /me/terminals': () => ({ body: terminals }),
      'POST /me/service-tickets': () => ({ status: 201, body: ticket() }),
    });
    renderNew('/service-tickets/new?serialNo=SN-0001');
    const select = await screen.findByLabelText('단말기');
    expect(select).toHaveValue('SN-0001');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['고르세요', '단말온 S100 SN-0001']);
    expect(screen.getByRole('button', { name: '접수하기' })).toBeDisabled();

    await userEvent.click(screen.getByLabelText('카드 인식 안 됨'));
    await userEvent.type(screen.getByLabelText('메모'), '오전부터');
    await userEvent.click(screen.getByRole('button', { name: '접수하기' }));
    expect(await screen.findByText('다른 화면')).toBeInTheDocument(); // 접수 화면(/service-tickets/7)으로 갔다
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ serialNo: 'SN-0001', symptom: '카드 인식 안 됨: 오전부터' });
  });

  it('이미 열린 A/S가 있으면(409) 점주 안내', async () => {
    loginAs();
    mockApi({
      'GET /me/terminals': () => ({ body: terminals }),
      'POST /me/service-tickets': () => ({ status: 409, body: { statusCode: 409, code: 'TICKET_ALREADY_OPEN', message: '단말기 SN-0001에 이미 열린 A/S 접수가 있습니다.' } }),
    });
    renderNew('/service-tickets/new?serialNo=SN-0001');
    await userEvent.click(await screen.findByLabelText('전원 안 켜짐'));
    await userEvent.click(screen.getByRole('button', { name: '접수하기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('이 단말기는 이미 접수된 A/S가 있습니다.');
  });

  it.each([
    [422, 'TERMINAL_NOT_IN_SERVICE', '사용 중인 단말기만 고장 접수할 수 있습니다.'],
    [404, 'NOT_FOUND', '찾는 내용이 없습니다.'],
  ])('접수가 %i로 실패하면 안내하고 단말기 목록을 다시 읽는다(낡은 화면)', async (status, code, text) => {
    loginAs();
    const { calls } = mockApi({
      'GET /me/terminals': () => ({ body: terminals }),
      'POST /me/service-tickets': () => ({ status, body: { statusCode: status, code, message: '서버 메시지' } }),
    });
    renderNew('/service-tickets/new?serialNo=SN-0001');
    await userEvent.click(await screen.findByLabelText('전원 안 켜짐'));
    await userEvent.click(screen.getByRole('button', { name: '접수하기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.path === '/me/terminals')).toHaveLength(2));
  });

  it('주소의 시리얼이 사용 중 목록에 없으면 고르지 않은 것으로', async () => {
    loginAs();
    mockApi({ 'GET /me/terminals': () => ({ body: terminals }) });
    renderNew('/service-tickets/new?serialNo=SN-0101');
    expect(await screen.findByLabelText('단말기')).toHaveValue('');
  });
});

describe('A/S 상세와 설치 확인', () => {
  const renderDetail = () => renderPage(<ServiceTicketDetailPage />, { route: '/service-tickets/7', path: '/service-tickets/:id' });
  const replacing = (replacementStatus: 'SHIPPED' | 'DELIVERED') =>
    ticket({ status: 'REPLACING', remoteChecked: true, replacementSerialNo: 'SN-0101', replacementStatus, outboundTrackingNo: 'NR-123' });

  it('교체 단말기가 배송 중이면 배송 중 단계이고 설치 확인 버튼이 없다', async () => {
    loginAs();
    mockApi({ 'GET /me/service-tickets/:id': () => ({ body: replacing('SHIPPED') }) });
    renderDetail();
    const steps = within(await screen.findByRole('list', { name: 'A/S 진행 단계' })).getAllByRole('listitem');
    expect(steps.find((s) => s.getAttribute('aria-current') === 'step')).toHaveTextContent('배송 중');
    expect(screen.getByText(/교체 단말기가 배송 중입니다/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'SN-0101' })).toHaveAttribute('href', '/terminals/SN-0101');
    expect(screen.queryByRole('button', { name: '설치 확인' })).not.toBeInTheDocument();
  });

  it('교체 중인데 교체 단말기 상태가 비어 있어도(null) 그려지고 설치 확인 버튼은 없다', async () => {
    loginAs();
    mockApi({ 'GET /me/service-tickets/:id': () => ({ body: ticket({ status: 'REPLACING', remoteChecked: true, replacementSerialNo: 'SN-0101', replacementStatus: null }) }) });
    renderDetail();
    const steps = within(await screen.findByRole('list', { name: 'A/S 진행 단계' })).getAllByRole('listitem');
    expect(steps.find((s) => s.getAttribute('aria-current') === 'step')).toHaveTextContent('교체 출고');
    expect(screen.queryByRole('button', { name: '설치 확인' })).not.toBeInTheDocument();
  });

  it('도착했으면 설치 확인 — 한 번 더 묻고, 확인하면 POST 뒤 다시 읽어 완료로', async () => {
    loginAs();
    let current = replacing('DELIVERED');
    const { calls } = mockApi({
      'GET /me/service-tickets/:id': () => ({ body: current }),
      'POST /me/service-tickets/:id/installations': () => {
        current = { ...current, status: 'CLOSED', replacementStatus: null, closedAt: '2026-10-28T05:00:00.000Z' };
        return { body: current };
      },
    });
    const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderDetail();
    const button = await screen.findByRole('button', { name: '설치 확인' });
    await userEvent.click(button);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0); // 취소하면 보내지 않는다
    await userEvent.click(button);
    expect(await screen.findByText('2026-10-28 14:00:00 KST')).toBeInTheDocument(); // 다시 읽은 접수의 끝난 때
    expect(ask).toHaveBeenCalledTimes(2);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/me/service-tickets/7/installations']);
    expect(screen.queryByRole('button', { name: '설치 확인' })).not.toBeInTheDocument();
    const steps = within(screen.getByRole('list', { name: 'A/S 진행 단계' })).getAllByRole('listitem');
    expect(steps.every((s) => s.className === 'done')).toBe(true);
  });

  it('설치 확인이 실패하면(422) 안내하고 다시 읽는다', async () => {
    loginAs();
    const { calls } = mockApi({
      'GET /me/service-tickets/:id': () => ({ body: replacing('DELIVERED') }),
      'POST /me/service-tickets/:id/installations': () => ({ status: 422, body: { statusCode: 422, code: 'TICKET_NOT_REPLACING', message: 'A/S 접수 7은(는) CLOSED 상태라 설치 확인을 할 수 없습니다(필요: REPLACING).' } }),
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: '설치 확인' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('지금은 설치 확인을 할 수 없는 단계입니다.');
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.path === '/me/service-tickets/7')).toHaveLength(2));
  });

  it('주소의 번호가 숫자가 아니면 요청 없이 없는 화면', async () => {
    loginAs();
    const { calls } = mockApi({});
    renderPage(<ServiceTicketDetailPage />, { route: '/service-tickets/abc', path: '/service-tickets/:id' });
    expect(await screen.findByText('없는 화면입니다.')).toBeInTheDocument();
    expect(calls.filter((c) => c.path.startsWith('/me/service-tickets'))).toHaveLength(0);
  });

  it('설치 확인이 실패한 뒤 다시 읽어 상태가 바뀌면 이전 오류 안내를 지운다', async () => {
    loginAs();
    let current = replacing('DELIVERED');
    mockApi({
      'GET /me/service-tickets/:id': () => ({ body: current }),
      'POST /me/service-tickets/:id/installations': () => {
        current = { ...current, status: 'CLOSED', replacementStatus: null, closedAt: '2026-10-28T05:00:00.000Z' }; // 본사가 먼저 끝냈다
        return { status: 422, body: { statusCode: 422, code: 'TICKET_NOT_REPLACING', message: 'CLOSED 상태' } };
      },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: '설치 확인' }));
    expect(await screen.findByText('2026-10-28 14:00:00 KST')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
