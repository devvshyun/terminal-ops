import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { loginAs, mockApi, renderPage } from '../test/render';
import { RolloutsPage, type RolloutView } from './RolloutsPage';
import { ServiceTicketDetailPage } from './ServiceTicketDetailPage';
import { ServiceTicketsPage, type TicketView } from './ServiceTicketsPage';

const ticket = (over: Partial<TicketView> = {}): TicketView => ({
  id: 7,
  serialNo: 'AS-1',
  merchantCode: 'GANGNAM-KIMBAP',
  symptom: '전원 꺼짐',
  status: 'OPEN',
  remoteNote: null,
  replacementSerialNo: null,
  outboundShipmentId: null,
  outboundTrackingNo: null,
  openedBy: 'kim',
  createdAt: '2026-10-27T00:00:00.000Z',
  closedAt: null,
  ...over,
});

describe('A/S (F7)', () => {
  it('목록은 최근 것부터 "더 보기"(beforeId), 상태로 거른다', async () => {
    const { calls } = mockApi({
      'GET /service-tickets': (c) =>
        c.query.get('beforeId') === '7'
          ? { body: { items: [ticket({ id: 3, serialNo: 'AS-0' })], nextBeforeId: null } }
          : { body: { items: [ticket()], nextBeforeId: 7 } },
    });
    renderPage(<ServiceTicketsPage />);
    expect(await screen.findByRole('link', { name: '#7' })).toHaveAttribute('href', '/service-tickets/7');
    await userEvent.click(screen.getByRole('button', { name: '더 보기' }));
    expect(await screen.findByRole('link', { name: '#3' })).toBeInTheDocument();
    expect(screen.getByText('끝')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('접수 상태'), 'REPLACING');
    await waitFor(() => expect(calls.at(-1)!.query.get('status')).toBe('REPLACING'));
  });

  it('접수하면 그 건의 화면으로 간다. 운영 중이 아니면 서버의 422를 보여 준다', async () => {
    let n = 0;
    mockApi({
      'GET /service-tickets': () => ({ body: { items: [], nextBeforeId: null } }),
      'POST /service-tickets': () =>
        ++n === 1
          ? { status: 422, body: { statusCode: 422, code: 'TERMINAL_NOT_IN_SERVICE', message: '운영 중(IN_SERVICE)인 단말기만 A/S 접수할 수 있습니다(현재: IN_STOCK).' } }
          : { status: 201, body: ticket({ id: 9 }) },
    });
    loginAs();
    renderPage(<ServiceTicketsPage />);
    await userEvent.type(screen.getByLabelText('고장 단말기 시리얼'), 'AS-1');
    await userEvent.type(screen.getByLabelText('증상'), '전원 꺼짐');
    await userEvent.click(screen.getByRole('button', { name: '접수' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('TERMINAL_NOT_IN_SERVICE');
    await userEvent.click(screen.getByRole('button', { name: '접수' }));
    expect(await screen.findByText('다른 화면')).toBeInTheDocument(); // /service-tickets/9로 이동
  });

  it('OPEN: 원격 점검 기록, 교체 단말기는 같은 모델 재고에서 골라 교체 출고', async () => {
    let current = ticket();
    const { calls } = mockApi({
      'GET /service-tickets/7': () => ({ body: current }),
      'GET /terminals/AS-1': () => ({ body: { serialNo: 'AS-1', modelCode: 'SN-200' } }),
      'GET /terminals': () => ({ body: { items: [{ serialNo: 'ST-9', modelCode: 'SN-200' }], total: 1, page: 1, size: 50 } }),
      'POST /service-tickets/7/remote-checks': (c) => {
        current = ticket({ remoteNote: (c.body as { note: string }).note });
        return { body: current };
      },
      'POST /service-tickets/7/replacements': () => {
        current = ticket({ status: 'REPLACING', replacementSerialNo: 'ST-9', outboundTrackingNo: 'BG-1' });
        return { status: 201, body: current };
      },
    });
    loginAs();
    renderPage(<ServiceTicketDetailPage />, { route: '/service-tickets/7', path: '/service-tickets/:id' });
    await userEvent.type(await screen.findByLabelText('점검 메모'), '재부팅 안내했으나 그대로');
    await userEvent.click(screen.getByRole('button', { name: '점검 기록' }));
    expect(await screen.findByText('재부팅 안내했으나 그대로')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/service-tickets/7/remote-checks')!.body).toEqual({ resolved: false, note: '재부팅 안내했으나 그대로' });

    const stockCall = calls.find((c) => c.path === '/terminals')!;
    expect([stockCall.query.get('status'), stockCall.query.get('modelCode')]).toEqual(['IN_STOCK', 'SN-200']);
    await screen.findByRole('option', { name: 'ST-9' });
    await userEvent.selectOptions(screen.getByLabelText('교체 단말기'), 'ST-9');
    await userEvent.click(screen.getByRole('button', { name: '교체 출고' }));
    expect(await screen.findByRole('button', { name: '설치 확인' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/service-tickets/7/replacements')!.body).toEqual({ replacementSerialNo: 'ST-9', carrier: 'BUNGAE' });
  });

  it('REPLACING: 설치 확인을 보낸다', async () => {
    const { calls } = mockApi({
      'GET /service-tickets/7': () => ({ body: ticket({ status: 'REPLACING', replacementSerialNo: 'ST-9', outboundTrackingNo: 'BG-1' }) }),
      'POST /service-tickets/7/installations': () => ({ body: ticket({ status: 'CLOSED' }) }),
    });
    loginAs();
    renderPage(<ServiceTicketDetailPage />, { route: '/service-tickets/7', path: '/service-tickets/:id' });
    await userEvent.click(await screen.findByRole('button', { name: '설치 확인' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/service-tickets/7/installations')).toBe(true));
    expect(screen.queryByLabelText('점검 메모')).not.toBeInTheDocument();
  });
});

describe('A/S 리뷰 반영 (Task 7 리뷰)', () => {
  const unprocessable = (code: string, message: string) => ({ status: 422, body: { statusCode: 422, code, message } });

  it('act가 422로 실패하면 상세를 다시 읽어 화면을 서버 상태에 맞춘다(TICKET_NOT_OPEN)', async () => {
    let current = ticket();
    const { calls } = mockApi({
      'GET /service-tickets/7': () => ({ body: current }),
      'GET /terminals/AS-1': () => ({ body: { serialNo: 'AS-1', modelCode: 'SN-200' } }),
      'GET /terminals': () => ({ body: { items: [], total: 0, page: 1, size: 50 } }),
      'POST /service-tickets/7/remote-checks': () => {
        current = ticket({ status: 'CLOSED', closedAt: '2026-10-27T01:00:00.000Z' }); // 다른 운영자가 먼저 종결
        return unprocessable('TICKET_NOT_OPEN', '접수됨(OPEN) 상태의 A/S만 처리할 수 있습니다(현재: CLOSED).');
      },
    });
    loginAs();
    renderPage(<ServiceTicketDetailPage />, { route: '/service-tickets/7', path: '/service-tickets/:id' });
    await userEvent.type(await screen.findByLabelText('점검 메모'), '재부팅');
    await userEvent.click(screen.getByRole('button', { name: '점검 기록' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('TICKET_NOT_OPEN');
    await waitFor(() => expect(screen.queryByLabelText('점검 메모')).not.toBeInTheDocument()); // 다시 읽어서 종결 상태로
    expect(calls.filter((c) => c.path === '/service-tickets/7' && c.method === 'GET').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('alert')).toHaveTextContent('TICKET_NOT_OPEN'); // 오류 안내는 남는다
  });

  it('고른 교체 단말기가 재고 목록에서 사라지면 선택이 비워지고 교체 출고 버튼이 꺼진다', async () => {
    let stock = [{ serialNo: 'ST-9', modelCode: 'SN-200' }];
    mockApi({
      'GET /service-tickets/7': () => ({ body: ticket() }),
      'GET /terminals/AS-1': () => ({ body: { serialNo: 'AS-1', modelCode: 'SN-200' } }),
      'GET /terminals': () => ({ body: { items: stock, total: stock.length, page: 1, size: 50 } }),
      'POST /service-tickets/7/replacements': () => {
        stock = []; // 그사이 다른 곳에서 출고돼 재고에서 빠짐
        return unprocessable('TERMINAL_NOT_IN_STOCK', '재고(IN_STOCK) 단말기만 교체할 수 있습니다.');
      },
    });
    loginAs();
    renderPage(<ServiceTicketDetailPage />, { route: '/service-tickets/7', path: '/service-tickets/:id' });
    await screen.findByRole('option', { name: 'ST-9' });
    await userEvent.selectOptions(screen.getByLabelText('교체 단말기'), 'ST-9');
    await userEvent.click(screen.getByRole('button', { name: '교체 출고' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('TERMINAL_NOT_IN_STOCK');
    await waitFor(() => expect(screen.queryByRole('option', { name: 'ST-9' })).not.toBeInTheDocument());
    expect(screen.getByLabelText('교체 단말기')).toHaveValue('');
    expect(screen.getByRole('button', { name: '교체 출고' })).toBeDisabled();
  });

  it('재고가 한 쪽(50대)보다 많으면 일부만 보인다고 안내한다', async () => {
    mockApi({
      'GET /service-tickets/7': () => ({ body: ticket() }),
      'GET /terminals/AS-1': () => ({ body: { serialNo: 'AS-1', modelCode: 'SN-200' } }),
      'GET /terminals': () => ({ body: { items: Array.from({ length: 50 }, (_, i) => ({ serialNo: `ST-${i}`, modelCode: 'SN-200' })), total: 120, page: 1, size: 50 } }),
    });
    renderPage(<ServiceTicketDetailPage />, { route: '/service-tickets/7', path: '/service-tickets/:id' });
    expect(await screen.findByText(/최근 50대만 표시/)).toBeInTheDocument();
  });

  it('원격 점검을 기록하면 "해결됨" 체크가 초기화된다', async () => {
    mockApi({
      'GET /service-tickets/7': () => ({ body: ticket() }),
      'GET /terminals/AS-1': () => ({ body: { serialNo: 'AS-1', modelCode: 'SN-200' } }),
      'GET /terminals': () => ({ body: { items: [], total: 0, page: 1, size: 50 } }),
      'POST /service-tickets/7/remote-checks': () => ({ body: ticket({ remoteNote: '메모' }) }), // 해결이 아니라 OPEN 그대로
    });
    loginAs();
    renderPage(<ServiceTicketDetailPage />, { route: '/service-tickets/7', path: '/service-tickets/:id' });
    await userEvent.type(await screen.findByLabelText('점검 메모'), '메모');
    await userEvent.click(screen.getByLabelText(/원격으로 해결됨/));
    expect(screen.getByLabelText(/원격으로 해결됨/)).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: '점검 기록' }));
    await waitFor(() => expect(screen.getByLabelText('점검 메모')).toHaveValue(''));
    expect(screen.getByLabelText(/원격으로 해결됨/)).not.toBeChecked();
  });

  it('주소의 번호가 숫자가 아니면 요청하지 않고 잘못된 주소라고 알린다', async () => {
    const { calls } = mockApi({});
    renderPage(<ServiceTicketDetailPage />, { route: '/service-tickets/abc', path: '/service-tickets/:id' });
    expect(await screen.findByText(/잘못된 주소/)).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('상태 필터를 바꾸면 이전 조건의 항목은 사라지고 새 조건의 결과만 보인다(회귀 방지)', async () => {
    mockApi({
      'GET /service-tickets': (c) =>
        c.query.get('status') === 'REPLACING'
          ? { body: { items: [ticket({ id: 5, serialNo: 'AS-5', status: 'REPLACING' })], nextBeforeId: null } }
          : { body: { items: [ticket()], nextBeforeId: null } },
    });
    renderPage(<ServiceTicketsPage />);
    expect(await screen.findByRole('link', { name: '#7' })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('접수 상태'), 'REPLACING');
    expect(await screen.findByRole('link', { name: '#5' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '#7' })).not.toBeInTheDocument();
  });
});

describe('펌웨어 배포 현황 (F8)', () => {
  const rollout = (over: Partial<RolloutView> = {}): RolloutView => ({
    id: 4,
    modelCode: 'SN-100',
    version: '2.1.0',
    status: 'RUNNING',
    stages: [10, 50, 100],
    currentStage: 1,
    failureThreshold: 0.2,
    minSamples: 3,
    stageTimeoutMs: 600_000,
    stageStartedAt: '2026-10-27T00:00:00.000Z',
    createdBy: 'kim',
    createdAt: '2026-10-26T00:00:00.000Z',
    finishedAt: null,
    endReason: null,
    stageStats: [
      { stage: 0, percent: 10, targets: 10, offered: 0, succeeded: 9, failed: 1, timedOut: 0 },
      { stage: 1, percent: 50, targets: 40, offered: 30, succeeded: 10, failed: 0, timedOut: 0 },
      { stage: 2, percent: 100, targets: 0, offered: 0, succeeded: 0, failed: 0, timedOut: 0 },
    ],
    ...over,
  });

  it('단계별 통계와 지금 단계, 진행 중이면 멈춤·중단(확인 뒤) 버튼', async () => {
    let current = rollout();
    const { calls } = mockApi({
      'GET /firmware-rollouts': () => ({ body: { items: [current, rollout({ id: 2, status: 'COMPLETED', endReason: '마지막 단계 완료' })], nextBeforeId: null } }),
      'POST /firmware-rollouts/4/pause': () => {
        current = rollout({ status: 'PAUSED' });
        return { body: current };
      },
      'POST /firmware-rollouts/4/abort': () => ({ body: rollout({ status: 'ABORTED' }) }),
    });
    loginAs();
    renderPage(<RolloutsPage />);
    const card = await screen.findByRole('article', { name: '배포 4' });
    const rows = within(card).getAllByRole('row');
    expect(rows[2]).toHaveAttribute('aria-current', 'step'); // 머리 행 다음 두 번째 단계
    const failedCell = within(rows[1]).getAllByRole('cell')[5]; // 1단계의 실패 칸
    expect([failedCell.textContent, failedCell.className]).toEqual(['1', 'bad']);
    const done = screen.getByRole('article', { name: '배포 2' });
    expect(within(done).queryByRole('button')).not.toBeInTheDocument();
    expect(within(done).getByText('끝난 이유: 마지막 단계 완료')).toBeInTheDocument();

    await userEvent.click(within(card).getByRole('button', { name: '멈춤' }));
    expect(await within(await screen.findByRole('article', { name: '배포 4' })).findByRole('button', { name: '재개' })).toBeInTheDocument();

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await userEvent.click(within(screen.getByRole('article', { name: '배포 4' })).getByRole('button', { name: '중단' }));
    expect(calls.some((c) => c.path === '/firmware-rollouts/4/abort')).toBe(false); // 취소하면 보내지 않는다
    await userEvent.click(within(screen.getByRole('article', { name: '배포 4' })).getByRole('button', { name: '중단' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/firmware-rollouts/4/abort')).toBe(true));
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('배포 제어가 422로 실패하면 목록을 다시 읽어 서버 상태에 맞춘다(ROLLOUT_NOT_RUNNING)', async () => {
    let current = rollout();
    const { calls } = mockApi({
      'GET /firmware-rollouts': () => ({ body: { items: [current], nextBeforeId: null } }),
      'POST /firmware-rollouts/4/pause': () => {
        current = rollout({ status: 'COMPLETED', endReason: '마지막 단계 완료' }); // 그사이 끝남
        return { status: 422, body: { statusCode: 422, code: 'ROLLOUT_NOT_RUNNING', message: '진행 중(RUNNING)인 배포만 멈출 수 있습니다.' } };
      },
    });
    loginAs();
    renderPage(<RolloutsPage />);
    await userEvent.click(within(await screen.findByRole('article', { name: '배포 4' })).getByRole('button', { name: '멈춤' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ROLLOUT_NOT_RUNNING');
    await waitFor(() => expect(within(screen.getByRole('article', { name: '배포 4' })).queryAllByRole('button')).toHaveLength(0));
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/firmware-rollouts').length).toBeGreaterThanOrEqual(2);
  });

  it('상태 필터를 바꾸면 이전 조건의 배포는 사라지고 새 조건의 결과만 보인다(회귀 방지)', async () => {
    mockApi({
      'GET /firmware-rollouts': (c) =>
        c.query.get('status') === 'COMPLETED'
          ? { body: { items: [rollout({ id: 2, status: 'COMPLETED' })], nextBeforeId: null } }
          : { body: { items: [rollout()], nextBeforeId: null } },
    });
    renderPage(<RolloutsPage />);
    expect(await screen.findByRole('article', { name: '배포 4' })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('배포 상태'), 'COMPLETED');
    expect(await screen.findByRole('article', { name: '배포 2' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: '배포 4' })).not.toBeInTheDocument();
  });
});
