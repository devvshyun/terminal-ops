import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockApi, renderPage } from '../test/render';
import { BatchHistoryPage } from './BatchHistoryPage';
import type { WeeklyReportView } from './reports/WeeklyReportsPage';

const syncRun = (over: Record<string, unknown> = {}) => ({
  id: 9,
  job: 'track-bungae',
  shipmentId: 1,
  trackingNo: 'BG-1',
  attempt: 2,
  worker: 'pid-1',
  outcome: 'ERROR',
  startedAt: '2026-10-27T00:00:00.000Z',
  finishedAt: null,
  fetched: 0,
  inserted: 0,
  duplicated: 0,
  detail: '응답 500',
  ...over,
});

const weekly = (over: Partial<WeeklyReportView> = {}): WeeklyReportView => ({
  weekStart: '2026-10-19',
  status: 'SENT',
  fileName: null,
  fileSize: null,
  generatedAt: null,
  sentAt: '2026-10-26T00:00:00.000Z',
  attempts: 1,
  lastError: null,
  alreadySent: true,
  queued: false,
  queuedAt: null,
  ...over,
});

describe('배치 실행 이력 (decisions/0039)', () => {
  it('택배 수집 실행: 큐·결과로 거르고 오류는 빨갛게, 탭을 바꾸면 VAN 대조·주간 리포트 이력', async () => {
    const { calls } = mockApi({
      'GET /sync-runs': () => ({ body: { items: [syncRun()], nextBeforeId: null } }),
      'GET /van-reconciliations': () => ({
        body: { items: [{ id: 2, status: 'FAILED', trigger: 'SCHEDULED', requestedBy: 'system:van-reconcile', startedAt: '2026-10-27T00:00:00.000Z', finishedAt: null, confirmed: 0 }], nextBeforeId: null },
      }),
      'GET /reports/weekly': () => ({ body: { items: [weekly()], nextBefore: null } }),
    });
    renderPage(<BatchHistoryPage />, { route: '/batch-runs', path: '/batch-runs' });
    expect(await screen.findByText('응답 500')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'ERROR' })).toHaveClass('bad');
    await userEvent.selectOptions(screen.getByLabelText('결과'), 'ERROR');
    await waitFor(() => expect(calls.filter((c) => c.path === '/sync-runs').at(-1)!.query.get('outcome')).toBe('ERROR'));

    await userEvent.click(screen.getByRole('tab', { name: 'VAN 대조' }));
    expect(await screen.findByRole('link', { name: '#2' })).toHaveAttribute('href', '/reports/van/2');
    expect(screen.getByText('주기')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: '주간 리포트' }));
    expect(await screen.findByRole('link', { name: '2026-10-19' })).toHaveAttribute('href', '/reports/weekly?week=2026-10-19');
    expect(screen.getByRole('tab', { name: '주간 리포트' })).toHaveAttribute('aria-selected', 'true');
  });

  it('탭은 주소(?tab=)에서 시작하고, 모르는 값이면 택배 수집으로 간다', async () => {
    mockApi({
      'GET /sync-runs': () => ({ body: { items: [syncRun()], nextBeforeId: null } }),
      'GET /reports/weekly': () => ({ body: { items: [weekly()], nextBefore: null } }),
    });
    const first = renderPage(<BatchHistoryPage />, { route: '/batch-runs?tab=weekly', path: '/batch-runs' });
    expect(await screen.findByRole('link', { name: '2026-10-19' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '주간 리포트' })).toHaveAttribute('aria-selected', 'true');
    first.unmount();
    renderPage(<BatchHistoryPage />, { route: '/batch-runs?tab=nope', path: '/batch-runs' });
    expect(await screen.findByText('응답 500')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '택배 수집' })).toHaveAttribute('aria-selected', 'true');
  });

  it('택배 수집: 더 보기는 beforeId로 이어 붙이고, 큐로 거른다', async () => {
    const { calls } = mockApi({
      'GET /sync-runs': (c) =>
        c.query.get('beforeId') === '9'
          ? { body: { items: [syncRun({ id: 8, outcome: 'OK', detail: null, trackingNo: 'BG-0' })], nextBeforeId: null } }
          : { body: { items: [syncRun()], nextBeforeId: 9 } },
    });
    renderPage(<BatchHistoryPage />, { route: '/batch-runs', path: '/batch-runs' });
    await screen.findByText('응답 500');
    await userEvent.click(screen.getByRole('button', { name: '더 보기' }));
    expect(await screen.findByText('BG-0')).toBeInTheDocument();
    expect(screen.getByText('BG-1')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('큐'), 'track-neurimbo');
    await waitFor(() => expect(calls.filter((c) => c.path === '/sync-runs').at(-1)!.query.get('job')).toBe('track-neurimbo'));
  });

  it('주간 리포트: 대기열에 있는 주는 지난 시도의 오류를 숨기고, 실패한 주는 오류를 빨갛게 보인다', async () => {
    mockApi({
      'GET /reports/weekly': () => ({
        body: {
          items: [
            weekly({ weekStart: '2026-10-26', status: 'FAILED', attempts: 2, sentAt: null, lastError: '메일 서버 응답 없음', queued: true, queuedAt: '2026-10-27T00:00:00.000Z' }),
            weekly({ weekStart: '2026-10-19', status: 'FAILED', attempts: 1, sentAt: null, lastError: '첨부 생성 실패' }),
          ],
          nextBefore: null,
        },
      }),
    });
    renderPage(<BatchHistoryPage />, { route: '/batch-runs?tab=weekly', path: '/batch-runs' });
    expect(await screen.findByText('첨부 생성 실패')).toHaveClass('bad');
    expect(screen.queryByText('메일 서버 응답 없음')).not.toBeInTheDocument();
    expect(screen.getByText('대기열')).toBeInTheDocument();
  });

  it('택배 수집 조건은 주소(?job=&outcome=)에 둔다 — 주소에서 시작하고, 바꾸면 주소가 바뀌며, 탭을 바꾸면 조건 없이 그 탭으로 간다', async () => {
    const { calls } = mockApi({
      'GET /sync-runs': () => ({ body: { items: [syncRun()], nextBeforeId: null } }),
      'GET /van-reconciliations': () => ({ body: { items: [], nextBeforeId: null } }),
    });
    renderPage(<BatchHistoryPage />, { route: '/batch-runs?tab=sync&job=track-neurimbo&outcome=ERROR', path: '/batch-runs' });
    await screen.findByText('응답 500');
    expect(screen.getByLabelText('큐')).toHaveValue('track-neurimbo');
    expect(screen.getByLabelText('결과')).toHaveValue('ERROR');
    expect([calls[0].query.get('job'), calls[0].query.get('outcome')]).toEqual(['track-neurimbo', 'ERROR']);
    await userEvent.selectOptions(screen.getByLabelText('결과'), 'OK');
    await waitFor(() => expect(calls.at(-1)!.query.get('outcome')).toBe('OK'));
    expect(calls.at(-1)!.query.get('job')).toBe('track-neurimbo');
    await userEvent.click(screen.getByRole('tab', { name: 'VAN 대조' }));
    await userEvent.click(screen.getByRole('tab', { name: '택배 수집' }));
    await waitFor(() => expect(screen.getByLabelText('결과')).toHaveValue(''));
    expect(screen.getByLabelText('큐')).toHaveValue('');
  });

  it('VAN 대조 탭: RUNNING 행이 있으면 2초마다 다시 읽고, 새로고침 버튼이 있다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let reads = 0;
      mockApi({
        'GET /van-reconciliations': () => {
          reads += 1;
          const status = reads >= 2 ? 'COMPLETED' : 'RUNNING';
          return { body: { items: [{ id: 5, status, trigger: 'MANUAL', requestedBy: '김운영', startedAt: '2026-10-27T00:00:00.000Z', finishedAt: null, confirmed: 0 }], nextBeforeId: null } };
        },
      });
      renderPage(<BatchHistoryPage />, { route: '/batch-runs?tab=van', path: '/batch-runs' });
      expect(await screen.findByText(/대조 진행 중 — 2초마다/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '새로고침' })).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await screen.findByText('COMPLETED')).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByText(/대조 진행 중 — 2초마다/)).not.toBeInTheDocument());
      expect(reads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('주간 리포트 탭: 대기열에 있는 주가 있으면 2초마다 다시 읽고, 새로고침 버튼이 있다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let reads = 0;
      mockApi({
        'GET /reports/weekly': () => {
          reads += 1;
          const done = reads >= 2;
          return { body: { items: [weekly({ status: done ? 'SENT' : 'GENERATED', queued: !done, queuedAt: done ? null : new Date().toISOString() })], nextBefore: null } };
        },
      });
      renderPage(<BatchHistoryPage />, { route: '/batch-runs?tab=weekly', path: '/batch-runs' });
      expect(await screen.findByText(/보내는 중 — 2초마다/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '새로고침' })).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await screen.findByText('SENT')).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByText(/보내는 중 — 2초마다/)).not.toBeInTheDocument());
      expect(reads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('이상 단말기 찾기는 실행 기록이 없다고 알린다', async () => {
    mockApi({ 'GET /sync-runs': () => ({ body: { items: [], nextBeforeId: null } }) });
    renderPage(<BatchHistoryPage />, { route: '/batch-runs', path: '/batch-runs' });
    expect(await screen.findByText(/이상 단말기 찾기는 실행 기록을 따로 남기지 않습니다/)).toBeInTheDocument();
  });
});
