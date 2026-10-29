import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { focusManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { dashboardApi, minutesAgo, outboxView, queue, queuesView, systemView } from '../test/fixtures';
import { MONITOR, mockApi, renderApp } from '../test/render';

const ME = { 'GET /auth/me': () => ({ body: MONITOR }) };
const row = (name: string) => screen.getByRole('cell', { name: new RegExp(`^${name}`) }).closest('tr')!;

describe('대시보드 (보강 6)', () => {
  it('상태 카드: api 버전·기동 시각, MySQL·Redis 응답, 워커 프로세스 이름(큐마다 겹치면 하나로)', async () => {
    mockApi({ ...ME, ...dashboardApi({ system: systemView({ redis: { ok: false, latencyMs: null, error: 'Error: connect ECONNREFUSED 127.0.0.1:6379' } }) }) });
    renderApp('/');
    expect(await screen.findByText('worker-a')).toBeInTheDocument();
    expect(screen.getByText('1.2ms')).toBeInTheDocument();
    expect(screen.getByText('응답 없음')).toBeInTheDocument();
    expect(screen.getByText('Error: connect ECONNREFUSED 127.0.0.1:6379')).toBeInTheDocument();
    expect(screen.getByText('(1시간 전)')).toBeInTheDocument(); // 기동 90분 전
  });

  it('워커가 하나도 없으면 경고', async () => {
    mockApi({ ...ME, ...dashboardApi({ system: systemView({ workers: [] }) }) });
    renderApp('/');
    expect(await screen.findByText('큐를 처리하는 워커가 없습니다')).toBeInTheDocument();
  });

  it('Redis를 못 읽어 워커 목록이 비면(redis ok:false) "워커 없음"이 아니라 "읽지 못함"(Task 1 리뷰 반영 8b3f9a4)', async () => {
    mockApi({ ...ME, ...dashboardApi({ system: systemView({ redis: { ok: false, latencyMs: null, error: 'TIMEOUT' }, workers: [] }) }) });
    renderApp('/');
    expect(await screen.findByText('워커 목록을 읽지 못함 — Redis 응답 없음')).toBeInTheDocument();
    expect(screen.queryByText('큐를 처리하는 워커가 없습니다')).not.toBeInTheDocument();
    expect(screen.getByText('?')).toBeInTheDocument(); // 수 대신
  });

  it('큐 표: 대기(우선순위 포함)·처리 중·지연·남은 실패(실패 job 화면 링크)·최근 15분·가장 오래 기다린 job·워커, 멈춤 표시', async () => {
    const queues = queuesView([
      queue('track-bungae', { counts: { waiting: 3, active: 1, delayed: 2, prioritized: 1, failed: 0, completed: 0 }, oldestWaitingAt: minutesAgo(5), completedRecent: 42, failedRecent: 0 }),
      queue('report', { counts: { waiting: 0, active: 0, delayed: 0, prioritized: 0, failed: 2, completed: 0 }, paused: true, failedRecent: 2, workers: 0 }),
    ]);
    mockApi({ ...ME, ...dashboardApi({ queues }) });
    renderApp('/');
    await screen.findByRole('heading', { name: '대시보드' });
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3));
    const bungae = within(row('track-bungae'));
    expect(bungae.getAllByRole('cell').map((c) => c.textContent)).toEqual(['track-bungae ', '4', '1', '2', '0', '42', '0', expect.stringContaining('(5분 전)'), '1']);
    const report = within(row('report'));
    expect(report.getByText('멈춤')).toBeInTheDocument();
    expect(report.getByRole('link', { name: '2' })).toHaveAttribute('href', '/failed?queue=report');
    expect(report.getAllByRole('cell').at(-1)).toHaveClass('alert'); // 워커 0
    expect(screen.getByRole('columnheader', { name: '최근 15분 완료' })).toBeInTheDocument();
  });

  it('Outbox: 상태별 수와 가장 오래된 PENDING·QUEUED', async () => {
    mockApi({ ...ME, ...dashboardApi({ outbox: outboxView({ counts: { PENDING: 3, QUEUED: 7, SENT: 120, FAILED: 1 }, oldestPendingAt: minutesAgo(2), oldestQueuedAt: minutesAgo(30) }) }) });
    renderApp('/');
    expect(await screen.findByText('120')).toBeInTheDocument();
    expect(screen.getByText('큐에 넣음(QUEUED)').nextSibling).toHaveTextContent('7');
    expect(screen.getByText('(2분 전)')).toBeInTheDocument();
    expect(screen.getByText('(30분 전)')).toBeInTheDocument();
  });

  it('다시 읽다 실패하면 마지막 값을 두고 오류를 함께 보인다', async () => {
    let down = false;
    const api = dashboardApi({ queues: queuesView([queue('outbox', { completedRecent: 9 })]) });
    mockApi({ ...ME, ...api, 'GET /ops/queues': () => (down ? { status: 503, body: { statusCode: 503, message: '잠시 멈춤' } } : api['GET /ops/queues']()) });
    renderApp('/', { refreshMs: 50 });
    expect(await screen.findByText('9')).toBeInTheDocument();
    down = true;
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('api가 Redis를 제때 읽지 못했습니다(HTTP 503). 잠시 뒤 다시 보세요.');
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/^마지막 갱신 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} KST/);
  });
});

describe('자동 새로고침 (decisions/0076)', () => {
  afterEach(() => {
    act(() => focusManager.setFocused(undefined));
  });

  const countQueues = (calls: { path: string }[]) => calls.filter((c) => c.path === '/ops/queues').length;

  it('간격마다 다시 읽고, 위 단추로 끄면 멈춘다', async () => {
    const { calls } = mockApi({ ...ME, ...dashboardApi() });
    renderApp('/', { refreshMs: 40 });
    await waitFor(() => expect(countQueues(calls)).toBeGreaterThanOrEqual(3));
    await userEvent.click(screen.getByRole('button', { name: '자동 새로고침 10초 · 켜짐' }));
    expect(screen.getByRole('button', { name: '자동 새로고침 10초 · 꺼짐' })).toHaveAttribute('aria-pressed', 'false');
    const stopped = countQueues(calls);
    await new Promise((r) => setTimeout(r, 200));
    expect(countQueues(calls)).toBe(stopped);
  });

  it('탭이 안 보이면(focusManager가 포커스 없음) 간격 읽기를 건너뛴다', async () => {
    const { calls } = mockApi({ ...ME, ...dashboardApi() });
    renderApp('/', { refreshMs: 40 });
    await waitFor(() => expect(countQueues(calls)).toBeGreaterThanOrEqual(2));
    act(() => focusManager.setFocused(false));
    const hidden = countQueues(calls);
    await new Promise((r) => setTimeout(r, 200));
    expect(countQueues(calls)).toBe(hidden);
  });
});
