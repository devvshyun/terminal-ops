import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dashboardBody } from '../test/fixtures';
import { mockApi, renderPage } from '../test/render';
import { HomePage } from './HomePage';

const health = { 'GET /health': () => ({ body: { status: 'ok' } }) };

describe('처음 화면 — 대시보드 (api decisions/0044)', () => {
  it('운영 현황 카드: 단말기(상태별·모델별), 접속 상태, 열린 이상(규칙별), 배포·A/S·VAN·이번 주 전이, 집계 기준 시각', async () => {
    mockApi({ ...health, 'GET /dashboard/summary': () => ({ body: dashboardBody() }) });
    renderPage(<HomePage />);
    const terminals = await screen.findByRole('region', { name: '단말기' });
    expect(within(terminals).getByText('6대')).toBeInTheDocument();
    expect(within(terminals).getByText('재고 2')).toBeInTheDocument();
    expect(within(terminals).getByText('운영 중 3')).toBeInTheDocument();
    expect(within(terminals).getByText('SN-100 4 · SN-200 2')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '접속 상태' })).getByText('온라인 1 · 오프라인 1 · 기록 없음 1')).toBeInTheDocument();
    const anomalies = screen.getByRole('region', { name: '열린 이상' });
    expect(within(anomalies).getByText('3건')).toBeInTheDocument();
    expect(within(anomalies).getByText('장기 오프라인 2')).toBeInTheDocument();
    expect(within(anomalies).getByRole('link', { name: '이상 단말기 보기' })).toHaveAttribute('href', '/reports/anomalies');
    expect(within(screen.getByRole('region', { name: '진행 중 배포' })).getByText('2건')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '열린 A/S' })).getByText('4건')).toBeInTheDocument();
    const van = screen.getByRole('region', { name: '최근 VAN 대조' });
    expect(within(van).getByRole('link', { name: 'VAN 대조 #12 상세' })).toHaveAttribute('href', '/reports/van/12');
    expect(within(van).getByText('어긋남 7건')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '이번 주 전이' })).getByText('15건')).toBeInTheDocument();
    expect(screen.getByText('2026-10-27 14:00:00 KST')).toBeInTheDocument();
    expect(screen.getByText('ok')).toBeInTheDocument(); // api 연결 확인은 그대로
  });

  it('새로고침은 refresh=true로 다시 집계한 값을 보여 준다', async () => {
    const { calls } = mockApi({
      ...health,
      'GET /dashboard/summary': (c) =>
        c.query.get('refresh') === 'true'
          ? { body: dashboardBody({ week: { weekStart: '2026-10-26', transitions: 16 }, cachedAt: '2026-10-27T05:01:00.000Z', fromCache: false }) }
          : { body: dashboardBody() },
    });
    renderPage(<HomePage />);
    await screen.findByText('15건');
    await userEvent.click(screen.getByRole('button', { name: '새로고침' }));
    expect(await screen.findByText('16건')).toBeInTheDocument();
    expect(screen.getByText('2026-10-27 14:01:00 KST')).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/dashboard/summary').map((c) => c.query.get('refresh'))).toEqual([null, 'true']);
  });

  it('VAN 대조가 아직 없으면 "없음"', async () => {
    mockApi({ ...health, 'GET /dashboard/summary': () => ({ body: dashboardBody({ van: null }) }) });
    renderPage(<HomePage />);
    expect(within(await screen.findByRole('region', { name: '최근 VAN 대조' })).getByText('없음')).toBeInTheDocument();
  });

  it('대시보드 요청이 실패하면 오류를 보여 준다(api 연결 표시는 따로)', async () => {
    mockApi({ ...health, 'GET /dashboard/summary': () => ({ status: 500, body: { statusCode: 500, message: '집계 실패' } }) });
    renderPage(<HomePage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('집계 실패');
    await waitFor(() => expect(screen.getByText('ok')).toBeInTheDocument());
  });

  it('"N초 전"은 시간이 지나면 저절로 바뀐다', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] }); // setTimeout은 진짜로 둬 react-query·findBy가 돈다
    vi.setSystemTime(new Date('2026-10-27T05:00:10.000Z'));
    mockApi({ ...health, 'GET /dashboard/summary': () => ({ body: dashboardBody() }) });
    renderPage(<HomePage />);
    expect(await screen.findByText(/10초 전/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText(/15초 전/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(50_000);
    });
    expect(screen.getByText(/1분 전/)).toBeInTheDocument();
  });

  it('새로고침이 실패하면 그 오류를 보여 주고 이전 집계는 그대로 둔다', async () => {
    mockApi({
      ...health,
      'GET /dashboard/summary': (c) =>
        c.query.get('refresh') === 'true' ? { status: 500, body: { statusCode: 500, message: '다시 집계 실패' } } : { body: dashboardBody() },
    });
    renderPage(<HomePage />);
    await screen.findByText('15건');
    await userEvent.click(screen.getByRole('button', { name: '새로고침' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('다시 집계 실패');
    expect(screen.getByText('15건')).toBeInTheDocument();
  });

  it('첫 조회가 끝나기 전에 새로고침이 실패해도 "불러오는 중"에 머물지 않고 다시 조회한다', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let plain = 0;
    const { calls } = mockApi({
      ...health,
      'GET /dashboard/summary': async (c) => {
        if (c.query.get('refresh') === 'true') return { status: 500, body: { statusCode: 500, message: '다시 집계 실패' } };
        plain += 1;
        if (plain === 1) await held; // 첫 조회는 붙잡아 둔다
        return { body: dashboardBody() };
      },
    });
    renderPage(<HomePage />);
    expect(await screen.findByRole('status')).toHaveTextContent('불러오는 중');
    await userEvent.click(screen.getByRole('button', { name: '새로고침' }));
    expect(await screen.findByText('15건')).toBeInTheDocument(); // 두 번째 일반 조회가 나가 카드가 그려진다
    expect(calls.filter((c) => c.path === '/dashboard/summary' && c.query.get('refresh') !== 'true').length).toBeGreaterThanOrEqual(2);
    release();
  });

  it('접근성: 카드 제목은 h4, 집계 시각은 <time>, 불러오는 중은 status, 새로고침 중에는 버튼 이름이 바뀐다', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    mockApi({
      ...health,
      'GET /dashboard/summary': async (c) => {
        if (c.query.get('refresh') === 'true') await gate;
        return { body: dashboardBody() };
      },
    });
    renderPage(<HomePage />);
    expect(screen.getByRole('status')).toHaveTextContent('불러오는 중');
    expect(await screen.findByRole('heading', { level: 4, name: '단말기' })).toBeInTheDocument();
    const time = document.querySelector('time');
    expect(time).toHaveAttribute('datetime', '2026-10-27T05:00:00.000Z');
    await userEvent.click(screen.getByRole('button', { name: '새로고침' }));
    const busy = await screen.findByRole('button', { name: '새로고침 중' });
    expect(busy).toBeDisabled();
    release();
    expect(await screen.findByRole('button', { name: '새로고침' })).toBeEnabled();
  });
});

afterEach(() => {
  vi.useRealTimers();
});
