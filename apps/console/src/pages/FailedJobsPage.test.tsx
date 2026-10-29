import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { OpsFailedJobView } from '@terminal-ops/contracts';
import { minutesAgo, queue, queuesView } from '../test/fixtures';
import { ADMIN, MONITOR, mockApi, renderApp } from '../test/render';

const job = (id: string, over: Partial<OpsFailedJobView> = {}): OpsFailedJobView => ({
  queue: 'report',
  id,
  name: 'van-reconcile',
  data: { runId: 7, apiToken: '[가림]' },
  failedReason: '브릿지VAN 목록 응답 503',
  attemptsMade: 1,
  maxAttempts: 1,
  createdAt: minutesAgo(30),
  failedAt: minutesAgo(29),
  ...over,
});

const QUEUES = queuesView([
  queue('outbox'),
  queue('report', { counts: { waiting: 0, active: 0, delayed: 0, prioritized: 0, failed: 2, completed: 0 } }),
]);

/** 실패 job 화면의 가짜 api. failed는 큐 이름마다 남은 job(부를 때마다 지금 값을 읽는다) */
function failedApi(me = MONITOR, failed: Record<string, OpsFailedJobView[]> = { report: [job('van-run-7'), job('repeat:weekly-report:1', { name: 'weekly-report', data: {} })] }) {
  return mockApi({
    'GET /auth/me': () => ({ body: me }),
    'GET /ops/queues': () => ({ body: QUEUES }),
    'GET /ops/queues/:name/failed': (call) => {
      const name = call.path.split('/')[3];
      const items = failed[name] ?? [];
      const start = Number(call.query.get('start'));
      return { body: { items: items.slice(start, start + 20), total: items.length, start, limit: 20 } };
    },
    'POST /ops/queues/:name/jobs/:id/retry': (call) => {
      const id = decodeURIComponent(call.path.split('/')[5]);
      failed.report = failed.report.filter((j) => j.id !== id);
      return { body: { queue: 'report', jobId: id, action: 'RETRY_JOB', actionId: 11 } };
    },
    'POST /ops/queues/:name/jobs/:id/remove': (call) => {
      const id = decodeURIComponent(call.path.split('/')[5]);
      failed.report = failed.report.filter((j) => j.id !== id);
      return { body: { queue: 'report', jobId: id, action: 'REMOVE_JOB', actionId: 12 } };
    },
  });
}

describe('실패 job (보강 6, decisions/0072)', () => {
  it('큐를 고르지 않으면 실패가 있는 첫 큐를 보이고, 실패 시각·job·시도·이유, 자세히는 가린 data', async () => {
    const { calls } = failedApi();
    renderApp('/failed');
    expect(await screen.findByText('van-run-7')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '큐' })).toHaveValue('report');
    expect(screen.getByRole('option', { name: 'report (실패 2)' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/ops/queues/report/failed')?.query.get('limit')).toBe('20');
    const row = screen.getByText('van-run-7').closest('tr')!;
    expect(within(row).getByText('1/1')).toBeInTheDocument();
    expect(within(row).getByText('브릿지VAN 목록 응답 503')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: '자세히' }));
    expect(screen.getByText(/"apiToken": "\[가림\]"/)).toBeInTheDocument();
    expect(screen.getByText('1–2 / 2')).toBeInTheDocument();
  });

  it('주소의 ?queue=로 큐를 고르고, 고르기를 바꾸면 그 큐를 읽는다', async () => {
    const { calls } = failedApi();
    renderApp('/failed?queue=outbox');
    expect(await screen.findByText('이 큐에 남은 실패 job이 없습니다.')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '큐' }), 'report');
    expect(await screen.findByText('van-run-7')).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith('/failed')).map((c) => c.path)).toEqual(['/ops/queues/outbox/failed', '/ops/queues/report/failed']);
  });

  it('다시 시도: 확인창을 취소하면 부르지 않고, 확인하면 POST 뒤 알림과 목록·큐 요약·작업 기록을 다시 읽는다(job id는 주소에 맞게 인코딩)', async () => {
    const { calls } = failedApi();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    renderApp('/failed');
    const row = (await screen.findByText('repeat:weekly-report:1')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: '다시 시도' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.click(within(row).getByRole('button', { name: '다시 시도' }));
    expect(confirm.mock.calls[1][0]).toBe('report의 job repeat:weekly-report:1(weekly-report)을(를) 다시 시도할까요? 시도 횟수를 0으로 되돌려 처음부터 다시 처리합니다.');
    expect(await screen.findByText('report의 job repeat:weekly-report:1을(를) 다시 시도했습니다(작업 기록 #11).')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.path).toBe('/ops/queues/report/jobs/repeat%3Aweekly-report%3A1/retry');
    await waitFor(() => expect(screen.queryByText('repeat:weekly-report:1')).not.toBeInTheDocument());
    expect(calls.filter((c) => c.path === '/ops/queues').length).toBeGreaterThanOrEqual(2);
  });

  it('지우기는 되돌릴 수 없다고 묻고 지운다', async () => {
    const { calls } = failedApi();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/failed');
    const row = (await screen.findByText('van-run-7')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: '지우기' }));
    expect(confirm.mock.calls[0][0]).toContain('되돌릴 수 없습니다.');
    expect(await screen.findByText('report의 job van-run-7을(를) 지웠습니다(작업 기록 #12).')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.path).toBe('/ops/queues/report/jobs/van-run-7/remove');
  });

  it('409 JOB_NOT_FAILED(다른 사람이 먼저 처리)면 안내를 보이고 목록을 다시 읽는다', async () => {
    const failed = { report: [job('van-run-7')] };
    const { calls } = mockApi({
      'GET /auth/me': () => ({ body: MONITOR }),
      'GET /ops/queues': () => ({ body: QUEUES }),
      'GET /ops/queues/:name/failed': () => ({ body: { items: failed.report, total: failed.report.length, start: 0, limit: 20 } }),
      'POST /ops/queues/:name/jobs/:id/retry': () => {
        failed.report = [];
        return { status: 409, body: { statusCode: 409, code: 'JOB_NOT_FAILED', message: '실패 상태가 아닌 job입니다(지금 completed): report van-run-7' } };
      },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/failed?queue=report');
    await userEvent.click(within((await screen.findByText('van-run-7')).closest('tr')!).getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('이 job은 이미 실패 상태가 아닙니다');
    expect(await screen.findByText('이 큐에 남은 실패 job이 없습니다.')).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith('/failed')).length).toBeGreaterThanOrEqual(2);
  });

  it('ADMIN은 보기만 — 다시 시도·지우기 단추 대신 안내', async () => {
    failedApi(ADMIN);
    renderApp('/failed');
    expect(await screen.findByText('van-run-7')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '다시 시도' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '지우기' })).not.toBeInTheDocument();
    expect(screen.getByText('다시 시도·지우기는 관제 계정만 할 수 있습니다(ADMIN은 보기만).')).toBeInTheDocument();
  });

  it('큐 요약(/ops/queues)이 실패해도 contracts의 큐 이름 여섯으로 고르기를 채워 실패 job을 볼 수 있다(수는 모름, Task 2·3 리뷰 반영)', async () => {
    mockApi({
      'GET /auth/me': () => ({ body: MONITOR }),
      'GET /ops/queues': () => ({ status: 503, body: { statusCode: 503, message: '큐 요약 늦음' } }),
      'GET /ops/queues/:name/failed': (call) => {
        const items = call.path.split('/')[3] === 'report' ? [job('van-run-7')] : [];
        return { body: { items, total: items.length, start: 0, limit: 20 } };
      },
    });
    renderApp('/failed?queue=report');
    expect(await screen.findByText('van-run-7', {}, { timeout: 4000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(6), { timeout: 4000 });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['track-bungae (실패 ?)', 'track-neurimbo (실패 ?)', 'carrier-sweep (실패 ?)', 'outbox (실패 ?)', 'device (실패 ?)', 'report (실패 ?)']);
    expect(screen.getByRole('combobox', { name: '큐' })).toHaveValue('report');
    expect(screen.getByRole('alert')).toHaveTextContent('큐 요약 늦음');
  });

  it('20개가 넘으면 다음·이전으로 start를 옮긴다', async () => {
    const many = Array.from({ length: 25 }, (_, i) => job(`j-${i + 1}`));
    const { calls } = failedApi(MONITOR, { report: many });
    renderApp('/failed?queue=report');
    expect(await screen.findByText('1–20 / 25')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '다음' }));
    expect(await screen.findByText('21–25 / 25')).toBeInTheDocument();
    expect(screen.getByText('j-21')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다음' })).toBeDisabled();
    expect(calls.filter((c) => c.path.endsWith('/failed')).map((c) => c.query.get('start'))).toEqual(['0', '20']);
  });

  it('큐를 고르지 않은 채 그 큐의 마지막 실패 job을 지워도 고른 큐가 다른 큐로 바뀌지 않는다(작업 뒤 큐를 주소에 고정, 최종 리뷰 Minor 2)', async () => {
    const failed: Record<string, OpsFailedJobView[]> = { report: [job('van-run-7')] };
    // 큐 요약의 실패 수도 지금 남은 job 수로 — 지운 뒤 "실패가 있는 첫 큐"가 없어진다
    const { calls } = mockApi({
      'GET /auth/me': () => ({ body: MONITOR }),
      'GET /ops/queues': () => ({ body: queuesView([queue('outbox'), queue('report', { counts: { waiting: 0, active: 0, delayed: 0, prioritized: 0, failed: failed.report.length, completed: 0 } })]) }),
      'GET /ops/queues/:name/failed': (call) => {
        const items = failed[call.path.split('/')[3]] ?? [];
        return { body: { items, total: items.length, start: 0, limit: 20 } };
      },
      'POST /ops/queues/:name/jobs/:id/remove': () => {
        failed.report = [];
        return { body: { queue: 'report', jobId: 'van-run-7', action: 'REMOVE_JOB', actionId: 12 } };
      },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/failed');
    await userEvent.click(within((await screen.findByText('van-run-7')).closest('tr')!).getByRole('button', { name: '지우기' }));
    expect(await screen.findByText('report의 job van-run-7을(를) 지웠습니다(작업 기록 #12).')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('option', { name: 'report (실패 0)' })).toBeInTheDocument());
    expect(await screen.findByText('이 큐에 남은 실패 job이 없습니다.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '큐' })).toHaveValue('report');
    // 잠깐이라도 다른 큐를 읽지 않는다
    expect(calls.filter((c) => c.path.endsWith('/failed')).every((c) => c.path === '/ops/queues/report/failed')).toBe(true);
  });

  it('둘째 쪽의 마지막 job을 지워 쪽이 비면 앞 쪽으로 옮긴다(최종 리뷰 Minor 2)', async () => {
    const failed = { report: Array.from({ length: 21 }, (_, i) => job(`j-${i + 1}`)) };
    failedApi(MONITOR, failed);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/failed?queue=report');
    expect(await screen.findByText('1–20 / 21')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '다음' }));
    await userEvent.click(within((await screen.findByText('j-21')).closest('tr')!).getByRole('button', { name: '지우기' }));
    expect(await screen.findByText('1–20 / 20')).toBeInTheDocument();
    expect(screen.queryByText('이 큐에 남은 실패 job이 없습니다.')).not.toBeInTheDocument();
  });

  it('둘째 쪽을 보다가 큐를 바꾸거나 메뉴 "실패 job"을 다시 누르면 첫 쪽부터(최종 리뷰 Minor 2)', async () => {
    const many = Array.from({ length: 25 }, (_, i) => job(`j-${i + 1}`));
    const { calls } = failedApi(MONITOR, { report: many, outbox: Array.from({ length: 22 }, (_, i) => job(`o-${i + 1}`, { queue: 'outbox' })) });
    renderApp('/failed?queue=report');
    await userEvent.click(await screen.findByRole('button', { name: '다음' }));
    expect(await screen.findByText('21–25 / 25')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '큐' }), 'outbox');
    expect(await screen.findByText('1–20 / 22')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '다음' }));
    expect(await screen.findByText('21–22 / 22')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: '실패 job' }));
    // 주소에 큐가 없으면 실패가 있는 첫 큐(report — 큐 요약의 실패 수 2)의 첫 쪽
    expect(await screen.findByText('1–20 / 25')).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith('/failed')).map((c) => `${c.path.split('/')[3]}:${c.query.get('start')}`)).toEqual(['report:0', 'report:20', 'outbox:0', 'outbox:20', 'report:0']);
  });
});
