import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { OpsActionView, OpsSchedulerView } from '@terminal-ops/contracts';
import { resetSessionForTest } from '../session';
import { dashboardApi, minutesAgo, outboxView } from '../test/fixtures';
import { ADMIN, MONITOR, mockApi, renderApp } from '../test/render';

const ME = { 'GET /auth/me': () => ({ body: MONITOR }) };

describe('주기 작업 (보강 6)', () => {
  it('코드 목록 순서대로 주기·등록 여부·다음 실행, Redis에만 남은 것은 "코드에 없음"', async () => {
    const list: OpsSchedulerView[] = [
      { id: 'outbox-relay', queue: 'outbox', jobName: 'relay', every: 2_000, pattern: null, tz: null, defined: true, registered: true, nextRunAt: new Date(Date.now() + 2_000).toISOString() },
      { id: 'weekly-report', queue: 'report', jobName: 'weekly-report', every: null, pattern: '0 9 * * 1', tz: 'Asia/Seoul', defined: true, registered: false, nextRunAt: null },
      { id: 'old-renamed', queue: 'device', jobName: 'detect-offline', every: 600_000, pattern: null, tz: null, defined: false, registered: true, nextRunAt: null },
    ];
    mockApi({ ...ME, 'GET /ops/schedulers': () => ({ body: list }) });
    renderApp('/schedulers');
    const relay = (await screen.findByText('outbox-relay')).closest('tr')!;
    expect(within(relay).getByText('2초마다')).toBeInTheDocument();
    expect(within(relay).getByText('등록됨')).toBeInTheDocument();
    const weekly = screen.getByText('weekly-report', { selector: 'td' }).closest('tr')!;
    expect(within(weekly).getByText('cron 0 9 * * 1 (Asia/Seoul)')).toBeInTheDocument();
    expect(within(weekly).getByText('등록 안 됨')).toBeInTheDocument();
    expect(within(screen.getByText(/old-renamed/).closest('tr')!).getByText('코드에 없음')).toBeInTheDocument();
  });
});

describe('최근 오류 (보강 6, decisions/0070)', () => {
  it('출처 이름·무엇·오류 글을 시각 순으로', async () => {
    mockApi({
      ...ME,
      'GET /ops/errors': () => ({
        body: [
          { source: 'SYNC_RUN', id: 3, at: minutesAgo(10), title: '택배 수집 실패 — track-bungae, 3번째 시도', message: 'PartnerTemporaryError: 번개택배 503' },
          { source: 'OUTBOX', id: 9, at: minutesAgo(40), title: '알림 #9 보내기 실패 — terminal.status_changed, 5번 시도', message: '톡톡메신저 400' },
        ],
      }),
    });
    renderApp('/errors');
    const first = (await screen.findByText('택배 수집 실패 — track-bungae, 3번째 시도')).closest('tr')!;
    expect(within(first).getByText('택배 수집')).toBeInTheDocument();
    expect(within(first).getByText('(10분 전)')).toBeInTheDocument();
    expect(screen.getAllByRole('row').map((r) => r.querySelectorAll('td')[1]?.textContent ?? 'head')).toEqual(['head', '택배 수집', '알림(Outbox)']);
  });

  it('없으면 없다고', async () => {
    mockApi({ ...ME, 'GET /ops/errors': () => ({ body: [] }) });
    renderApp('/errors');
    expect(await screen.findByText('최근 오류가 없습니다.')).toBeInTheDocument();
  });
});

describe('작업 기록 (보강 6, decisions/0073)', () => {
  const action = (id: number, over: Partial<OpsActionView> = {}): OpsActionView => ({
    id,
    action: 'RETRY_JOB',
    actor: 'monitor',
    actorRole: 'MONITOR',
    queue: 'report',
    jobId: `van-run-${id}`,
    jobName: 'van-reconcile',
    detail: { failedReason: '503', attemptsMade: 1 },
    createdAt: minutesAgo(id),
    ...over,
  });

  it('누가·작업·대상·그때 사정, "더 보기"는 beforeId로 다음 쪽', async () => {
    const { calls } = mockApi({
      ...ME,
      'GET /ops/actions': (call) =>
        call.query.get('beforeId') === '5'
          ? { body: { items: [action(4, { action: 'REQUEUE_OUTBOX', queue: null, jobId: null, jobName: null, detail: { checked: 2, requeuedCount: 1 } })], nextBeforeId: null } }
          : { body: { items: [action(6), action(5, { action: 'REMOVE_JOB' })], nextBeforeId: 5 } },
    });
    renderApp('/actions');
    const first = (await screen.findByText('report / van-run-6 (van-reconcile)')).closest('tr')!;
    expect(within(first).getByText('monitor (MONITOR)')).toBeInTheDocument();
    expect(within(first).getByText('다시 시도')).toBeInTheDocument();
    expect(within(first).getByText('{"failedReason":"503","attemptsMade":1}')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '더 보기' }));
    const sweep = (await screen.findByText('Outbox 복구 sweep')).closest('tr')!;
    expect(within(sweep).getByText('Outbox')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '더 보기' })).not.toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/ops/actions').map((c) => c.query.get('beforeId'))).toEqual([null, '5']);
  });

  it('자동 새로고침은 첫 쪽만 펼쳤을 때만 — "더 보기"로 쪽을 늘리면 간격 다시 읽기를 멈춘다(펼친 쪽 수만큼 요청이 늘지 않게, 최종 리뷰 Minor 6a)', async () => {
    const { calls } = mockApi({
      ...ME,
      'GET /ops/actions': (call) =>
        call.query.get('beforeId') === '5' ? { body: { items: [action(4)], nextBeforeId: null } } : { body: { items: [action(6), action(5)], nextBeforeId: 5 } },
    });
    renderApp('/actions', { refreshMs: 40 });
    const reads = () => calls.filter((c) => c.path === '/ops/actions').length;
    // 첫 쪽만이면 간격마다 다시 읽는다
    await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(3));
    await userEvent.click(screen.getByRole('button', { name: '더 보기' }));
    expect(await screen.findByText('report / van-run-4 (van-reconcile)')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 80));
    const after = reads();
    await new Promise((r) => setTimeout(r, 300));
    expect(reads()).toBe(after);
  });
});

describe('Outbox 복구 sweep (보강 6, decisions/0042·0073)', () => {
  it('관제: 확인 뒤 POST, 결과(본 수·다시 넣은 id·작업 기록)를 보이고 Outbox 요약을 다시 읽는다', async () => {
    const { calls } = mockApi({ ...ME, ...dashboardApi({ outbox: outboxView({ counts: { PENDING: 0, QUEUED: 4, SENT: 1, FAILED: 0 } }) }), 'POST /ops/outbox/requeue': () => ({ body: { checked: 3, requeued: [7, 8], actionId: 21 } }) });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: '멈춘 QUEUED 복구 sweep 지금 실행' }));
    expect(confirm.mock.calls[0][0]).toBe('만든 지 60초 지난 QUEUED 알림 중 큐에 job이 없는 것을 다시 넣을까요? (주기 작업 outbox-requeue와 같은 일)');
    expect(await screen.findByText('QUEUED 3건을 보고 2건을 다시 넣었습니다(#7, #8). 작업 기록 #21')).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/ops/outbox').length).toBeGreaterThanOrEqual(2);
  });

  it('확인창을 취소하면 부르지 않는다. ADMIN에게는 단추가 없다', async () => {
    const { calls } = mockApi({ ...ME, ...dashboardApi() });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { unmount } = renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: '멈춘 QUEUED 복구 sweep 지금 실행' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    unmount();
    resetSessionForTest(); // 다음 그리기에서 /auth/me를 다시 묻게

    mockApi({ 'GET /auth/me': () => ({ body: ADMIN }), ...dashboardApi() });
    renderApp('/');
    expect(await screen.findByText('보냄(SENT)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '멈춘 QUEUED 복구 sweep 지금 실행' })).not.toBeInTheDocument();
  });
});
