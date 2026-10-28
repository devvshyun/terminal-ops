import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { keyset, page, terminal, terminalDetail, ticket } from '../test/fixtures';
import { loginAs, mockApi, renderPage } from '../test/render';
import { HomePage } from './HomePage';
import { TerminalDetailPage } from './TerminalDetailPage';

/** "N분 전"이 실제 시계에 흔들리지 않게 Date만 고정한다(타이머는 진짜 — TanStack Query·user-event가 쓴다) */
const freeze = () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-28T03:00:00.000Z'));
};

const shipping = terminal({
  serialNo: 'SN-0101',
  status: 'SHIPPED',
  connectivity: null,
  shipment: {
    carrier: 'NEURIMBO',
    trackingNo: 'NR-123',
    status: 'IN_TRANSIT',
    createdAt: '2026-10-28T00:00:00.000Z',
    deliveredAt: null,
    ticketId: 7,
    events: [{ code: 'PICKED_UP', occurredAt: '2026-10-28T01:00:00.000Z' }],
  },
});

describe('홈 (보강 3, decisions/0060)', () => {
  it('오고 있는 단말기 → 진행 중 A/S → 사용 중 단말기 → 회수, 점주 말로', async () => {
    freeze();
    loginAs();
    const { calls } = mockApi({
      'GET /me/terminals': () => ({
        body: page([
          terminal(),
          terminal({ serialNo: 'SN-0002', connectivity: { online: false, lastSeenAt: '2026-10-28T01:00:00.000Z', firmwareVersion: '1.1.0' } }),
          shipping,
          terminal({ serialNo: 'SN-0009', status: 'RETURN_REQUESTED', connectivity: null }),
        ]),
      }),
      'GET /me/service-tickets': () => ({ body: keyset([ticket({ status: 'REPLACING', remoteChecked: true, replacementStatus: 'SHIPPED' }), ticket({ id: 3, status: 'CLOSED' })]) }),
    });
    renderPage(<HomePage />);

    const headings = await screen.findAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual(['오고 있는 단말기', '진행 중인 A/S', '사용 중인 단말기', '회수']);

    const coming = within(screen.getByRole('region', { name: '오고 있는 단말기' }));
    expect(coming.getByText('배송 중')).toBeInTheDocument();
    expect(coming.getByText('느림보물류 NR-123 · 이동 중')).toBeInTheDocument();
    expect(coming.getByText('A/S #7 교체 단말기')).toBeInTheDocument();

    const tickets = within(screen.getByRole('region', { name: '진행 중인 A/S' }));
    expect(tickets.getAllByRole('link')).toHaveLength(1); // 완료(CLOSED)는 빠진다
    expect(tickets.getByText('지금 단계: 배송 중')).toBeInTheDocument();
    expect(tickets.getByText('교체 진행 중')).toBeInTheDocument();

    const inService = within(screen.getByRole('region', { name: '사용 중인 단말기' }));
    expect(inService.getByText(/연결됨 · 마지막 접속 2분 전/)).toBeInTheDocument();
    expect(inService.getByText(/연결 끊김 · 마지막 접속 2시간 전/)).toBeInTheDocument();
    expect(inService.getAllByRole('link')[0]).toHaveAttribute('href', '/terminals/SN-0001');

    const returns = within(screen.getByRole('region', { name: '회수' }));
    expect(returns.getByText('회수 준비 중')).toBeInTheDocument();
    expect(returns.getByText(/기사님이 방문해 수거합니다/)).toBeInTheDocument();

    expect(calls.find((c) => c.path === '/me/terminals')?.query.get('size')).toBe('100');
  });

  it('단말기는 왔는데 A/S 목록이 아직 오는 중이면 "불러오는 중"', async () => {
    loginAs();
    mockApi({
      'GET /me/terminals': () => ({ body: page([terminal()]) }),
      'GET /me/service-tickets': () => new Promise(() => {}),
    });
    renderPage(<HomePage />);
    const region = within(await screen.findByRole('region', { name: '진행 중인 A/S' }));
    expect(region.getByText('불러오는 중…')).toBeInTheDocument();
    expect(region.queryByText('진행 중인 A/S가 없습니다.')).not.toBeInTheDocument();
  });

  it('배송 완료된 교체 단말기는 설치 확인 안내, 회수 요청은 새 문구', async () => {
    loginAs();
    mockApi({
      'GET /me/terminals': () => ({ body: page([{ ...shipping, status: 'DELIVERED' }, terminal({ serialNo: 'SN-0009', status: 'RETURN_REQUESTED', connectivity: null })]) }),
      'GET /me/service-tickets': () => ({ body: keyset([]) }),
    });
    renderPage(<HomePage />);
    expect(await screen.findByText('설치한 뒤 A/S 화면에서 설치 확인을 눌러 주세요.')).toBeInTheDocument();
    expect(screen.getByText('고장 단말기를 상자에 담아 두세요. 기사님이 방문해 수거합니다.')).toBeInTheDocument();
  });

  it('단말기도 A/S도 없으면 안내만', async () => {
    loginAs();
    mockApi({ 'GET /me/terminals': () => ({ body: page([]) }), 'GET /me/service-tickets': () => ({ body: keyset([]) }) });
    renderPage(<HomePage />);
    expect(await screen.findByText('우리 매장에 등록된 단말기가 없습니다.')).toBeInTheDocument();
    expect(await screen.findByText('진행 중인 A/S가 없습니다.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '사용 중인 단말기' })).not.toBeInTheDocument();
  });
});

describe('단말기 상세', () => {
  const renderDetail = (serialNo = 'SN-0001') => renderPage(<TerminalDetailPage />, { route: `/terminals/${serialNo}`, path: '/terminals/:serialNo' });

  it('사용 중: 연결·펌웨어, 지난 일은 최근 것 위에 점주 말로, 열린 A/S가 없으면 고장 접수 링크', async () => {
    freeze();
    loginAs();
    const { calls } = mockApi({
      'GET /me/terminals/:serialNo': () => ({ body: terminalDetail() }),
      'GET /me/service-tickets': () => ({ body: keyset([ticket({ id: 3, status: 'CLOSED' })]) }),
    });
    renderDetail();
    expect(await screen.findByRole('heading', { name: '단말온 S100' })).toBeInTheDocument();
    expect(screen.getByText(/연결됨 · 마지막 접속 2분 전/)).toBeInTheDocument();
    expect(screen.getByText('2026-10-28 11:58:00 KST')).toBeInTheDocument();
    expect(screen.getByText('1.2.0')).toBeInTheDocument();
    const events = within(screen.getByRole('list', { name: '지난 일' })).getAllByRole('listitem');
    expect(events.map((e) => e.textContent)).toEqual(['10-20 10:00 설치 완료', '10-19 14:00 매장 도착', '10-18 12:00 택배 출발', '10-18 10:00 우리 매장으로 배정']);
    expect(await screen.findByRole('link', { name: /고장 접수하기/ })).toHaveAttribute('href', '/service-tickets/new?serialNo=SN-0001');
    expect(screen.getByRole('link', { name: /A\/S #3/ })).toHaveAttribute('href', '/service-tickets/3');
    expect(calls.find((c) => c.path === '/me/service-tickets')?.query.get('serialNo')).toBe('SN-0001');
  });

  it('열린 A/S가 있으면 고장 접수 링크를 숨긴다', async () => {
    loginAs();
    mockApi({
      'GET /me/terminals/:serialNo': () => ({ body: terminalDetail() }),
      'GET /me/service-tickets': () => ({ body: keyset([ticket({ status: 'OPEN' })]) }),
    });
    renderDetail();
    expect(await screen.findByRole('link', { name: /A\/S #7/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /고장 접수하기/ })).not.toBeInTheDocument();
  });

  it('배송 중인 교체 단말기: 택배 단계(지금 단계 표시)와 A/S 링크, 연결 칸은 없다', async () => {
    loginAs();
    mockApi({
      'GET /me/terminals/:serialNo': () => ({ body: { ...shipping, events: [{ status: 'ALLOCATED', occurredAt: '2026-10-28T00:00:00.000Z' }] } }),
      'GET /me/service-tickets': () => ({ body: keyset([]) }),
    });
    renderDetail('SN-0101');
    const steps = within(await screen.findByRole('list', { name: '배송 단계' })).getAllByRole('listitem');
    expect(steps.map((s) => s.textContent)).toEqual(['출고', '택배사 인수', '이동 중', '배송 출발', '배송 완료']);
    expect(steps[2]).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('link', { name: '#7 교체 단말기' })).toHaveAttribute('href', '/service-tickets/7');
    expect(screen.queryByRole('heading', { name: '연결' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /고장 접수하기/ })).not.toBeInTheDocument();
  });

  it('배송 완료(DELIVERED)된 교체 단말기: 홈과 같은 설치 안내', async () => {
    loginAs();
    mockApi({
      'GET /me/terminals/:serialNo': () => ({ body: { ...shipping, status: 'DELIVERED', events: [{ status: 'ALLOCATED', occurredAt: '2026-10-28T00:00:00.000Z' }] } }),
      'GET /me/service-tickets': () => ({ body: keyset([]) }),
    });
    renderDetail('SN-0101');
    expect(await screen.findByText('설치한 뒤 A/S 화면에서 설치 확인을 눌러 주세요.')).toBeInTheDocument();
  });

  it('회수 중(RETURNING)은 수거 안내, 접속 기록이 없으면 "접속 기록 없음"', async () => {
    loginAs();
    mockApi({
      'GET /me/terminals/:serialNo': () =>
        ({ body: terminalDetail({ status: 'RETURNING', connectivity: { online: false, lastSeenAt: null, firmwareVersion: null } }) }),
      'GET /me/service-tickets': () => ({ body: keyset([]) }),
    });
    renderDetail();
    expect(await screen.findByText('기사님이 수거했습니다. 본사에 도착하면 회수 완료로 바뀝니다.')).toBeInTheDocument();
    expect(screen.getByText('접속 기록 없음')).toBeInTheDocument();
  });

  it('남의 단말기·본사로 돌아간 단말기(404)는 "찾는 내용이 없습니다"', async () => {
    loginAs();
    mockApi({
      'GET /me/terminals/:serialNo': () => ({ status: 404, body: { statusCode: 404, message: '단말기 SN-9이(가) 없습니다.' } }),
      'GET /me/service-tickets': () => ({ body: keyset([]) }),
    });
    renderDetail('SN-9');
    expect(await screen.findByRole('alert')).toHaveTextContent('찾는 내용이 없습니다.');
  });
});
