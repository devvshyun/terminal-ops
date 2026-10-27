import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
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
    expect(within(van).getByRole('link', { name: '#12' })).toHaveAttribute('href', '/reports/van/12');
    expect(within(van).getByText('어긋남 7건')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '이번 주 전이' })).getByText('15건')).toBeInTheDocument();
    expect(screen.getByText(/2026-10-27 14:00:00 KST 기준/)).toBeInTheDocument();
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
    expect(screen.getByText(/2026-10-27 14:01:00 KST 기준/)).toBeInTheDocument();
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
});
