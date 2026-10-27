import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Link } from 'react-router';
import { loginAs, mockApi, renderPage } from '../../test/render';
import { AnomaliesPage } from './AnomaliesPage';
import { PurchaseOrdersPage } from './PurchaseOrdersPage';
import { VanRunDetailPage } from './VanRunDetailPage';
import { VanRunsPage, type VanRunView } from './VanRunsPage';
import { lastWeekMonday, queueWait, WORKER_HINT_AFTER_MIN, weekStartProblem, WeeklyReportsPage, type WeeklyReportView } from './WeeklyReportsPage';

/** 'YYYY-MM-DD'에 days일을 더한다(테스트용) */
const addDays = (day: string, days: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

describe('이상 단말기 (F4)', () => {
  it('규칙 이름·기준일은 서버 목록으로, 기본은 열린 것. 규칙을 고르면 다시 부르고, 지금 찾기는 요약을 보여 준다', async () => {
    const { calls } = mockApi({
      'GET /anomaly-rules': () => ({
        body: [
          { rule: 'DELIVERED_NOT_INSTALLED', label: '배송 완료 후 미설치', days: 7 },
          { rule: 'IN_SERVICE_NO_MERCHANT', label: '운영 중 가맹점 없음', days: null },
        ],
      }),
      'GET /anomalies': () => ({
        body: {
          items: [
            {
              id: 1,
              serialNo: 'AN-1',
              status: 'DELIVERED',
              rule: 'DELIVERED_NOT_INSTALLED',
              ruleLabel: '배송 완료 후 미설치',
              detectedAt: '2026-10-27T00:00:00.000Z',
              lastSeenAt: '2026-10-27T00:00:00.000Z',
              resolvedAt: null,
              detail: { days: 9 },
            },
          ],
          nextAfterId: null,
        },
      }),
      'POST /anomaly-scans': () => ({ body: { detected: 2, continuing: 5, resolved: 1, newSerials: ['AN-2', 'AN-3'] } }),
    });
    loginAs();
    renderPage(<AnomaliesPage />);
    expect(await screen.findByText('배송 완료 후 미설치 · 9일')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '배송 완료 후 미설치 (7일)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '운영 중 가맹점 없음' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/anomalies')!.query.get('open')).toBe('true');
    await userEvent.selectOptions(screen.getByLabelText('규칙'), 'DELIVERED_NOT_INSTALLED');
    await waitFor(() => expect(calls.filter((c) => c.path === '/anomalies').at(-1)!.query.get('rule')).toBe('DELIVERED_NOT_INSTALLED'));
    await userEvent.click(screen.getByRole('button', { name: '지금 찾기' }));
    expect(await screen.findByRole('status')).toHaveTextContent('새로 2건, 계속 5건, 풀림 1건');
  });

  it('다른 찾기가 돌고 있으면(409 ANOMALY_SCAN_RUNNING) 서버 메시지와 기다리라는 안내를 보여 준다', async () => {
    mockApi({
      'GET /anomaly-rules': () => ({ body: [] }),
      'GET /anomalies': () => ({ body: { items: [], nextAfterId: null } }),
      'POST /anomaly-scans': () => ({ status: 409, body: { statusCode: 409, code: 'ANOMALY_SCAN_RUNNING', message: '이상 단말기 찾기가 이미 돌고 있습니다.' } }),
    });
    loginAs();
    renderPage(<AnomaliesPage />);
    await userEvent.click(await screen.findByRole('button', { name: '지금 찾기' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('이미 진행 중인 작업이 있습니다');
    expect(alert).toHaveTextContent('이상 단말기 찾기가 이미 돌고 있습니다.');
    expect(alert).toHaveTextContent('ANOMALY_SCAN_RUNNING');
  });
});

const run = (over: Partial<VanRunView> = {}): VanRunView => ({
  id: 3,
  status: 'COMPLETED',
  trigger: 'MANUAL',
  requestedBy: 'kim',
  acknowledgeDrop: false,
  startedAt: '2026-10-27T00:00:00.000Z',
  heartbeatAt: '2026-10-27T00:00:00.000Z',
  finishedAt: '2026-10-27T00:01:00.000Z',
  pages: 2,
  fetched: 800,
  retries: 1,
  candidates: 5,
  confirmed: 3,
  resolved: 2,
  unverifiable: 0,
  counts: { NOT_REGISTERED: 1, MERCHANT_MISMATCH: 2 },
  phaseMs: { collect: 900, compare: 20, reverify: 300 },
  error: null,
  ...over,
});

describe('VAN 등록 대조 (F9)', () => {
  it('실행 목록과 수동 실행(202). 진행 중인 실행이 있으면 실행 버튼이 꺼지고 다시 읽기를 알린다', async () => {
    let runs = [run()];
    const { calls } = mockApi({
      'GET /van-reconciliations': () => ({ body: { items: runs, nextBeforeId: null } }),
      'POST /van-reconciliations': () => {
        runs = [run({ id: 4, status: 'RUNNING', finishedAt: null }), ...runs];
        return { status: 202, body: runs[0] };
      },
    });
    loginAs();
    renderPage(<VanRunsPage />);
    expect(await screen.findByRole('link', { name: '#3' })).toHaveAttribute('href', '/reports/van/3');
    await userEvent.click(screen.getByLabelText(/수집 급감 확인함/));
    await userEvent.click(screen.getByRole('button', { name: '대조 실행' }));
    expect(await screen.findByRole('link', { name: '#4' })).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ acknowledgeDrop: true });
    expect(screen.getByRole('button', { name: '대조 실행' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('대조 진행 중');
  });

  it('실행 상세: 요약, 종류 이름(kindLabel), 재검증 기본은 어긋남만, 더 보기는 afterId', async () => {
    const { calls } = mockApi({
      'GET /van-reconciliations/3': (c) => ({
        body: {
          ...run(),
          items: c.query.get('afterId')
            ? [{ id: 12, serialNo: 'VN-2', kind: 'NOT_REGISTERED', kindLabel: '미등록', ourValue: 'IN_SERVICE / A', vanValue: 'VAN에 없음', verified: true, reason: null }]
            : [{ id: 11, serialNo: 'VN-1', kind: 'MERCHANT_MISMATCH', kindLabel: '가맹점 다름', ourValue: 'IN_SERVICE / A', vanValue: 'ACTIVE / B', verified: true, reason: null }],
          nextAfterId: c.query.get('afterId') ? null : 11,
        },
      }),
    });
    renderPage(<VanRunDetailPage />, { route: '/reports/van/3', path: '/reports/van/:id' });
    expect(await screen.findByText('가맹점 다름')).toBeInTheDocument();
    expect(screen.getByText('후보 5 → 어긋남 3, 재검증으로 풀림 2, 확인 불가 0')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'MERCHANT_MISMATCH (2)' })).toBeInTheDocument();
    expect(calls[0].query.get('verified')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: '더 보기' }));
    expect(await screen.findByText('미등록')).toBeInTheDocument();
    expect(calls.at(-1)!.query.get('afterId')).toBe('11');
  });

  it('진행 중인 실행이 있으면(409 VAN_RECONCILIATION_RUNNING) 서버 메시지와 기다리라는 안내를 보여 준다', async () => {
    mockApi({
      'GET /van-reconciliations': () => ({ body: { items: [run()], nextBeforeId: null } }),
      'POST /van-reconciliations': () => ({
        status: 409,
        body: { statusCode: 409, code: 'VAN_RECONCILIATION_RUNNING', message: '진행 중인 VAN 대조가 있습니다. 끝난 뒤 다시 요청하세요.' },
      }),
    });
    loginAs();
    renderPage(<VanRunsPage />);
    await screen.findByRole('link', { name: '#3' });
    await userEvent.click(screen.getByRole('button', { name: '대조 실행' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('이미 진행 중인 작업이 있습니다');
    expect(alert).toHaveTextContent('VAN_RECONCILIATION_RUNNING');
  });

  it('실행 번호가 바뀌면 종류·재검증 필터를 처음 값으로 되돌린다', async () => {
    const { calls } = mockApi({
      'GET /van-reconciliations/:id': (c) => ({ body: { ...run({ id: Number(c.path.split('/').at(-1)) }), items: [], nextAfterId: null } }),
    });
    renderPage(
      <>
        <VanRunDetailPage />
        <Link to="/reports/van/4">다음 실행</Link>
      </>,
      { route: '/reports/van/3', path: '/reports/van/:id' },
    );
    await screen.findByRole('heading', { name: 'VAN 대조 #3' });
    await screen.findByRole('option', { name: 'MERCHANT_MISMATCH (2)' });
    await userEvent.selectOptions(screen.getByLabelText('재검증'), '');
    await userEvent.selectOptions(screen.getByLabelText('종류'), 'MERCHANT_MISMATCH');
    await waitFor(() => expect(calls.at(-1)!.query.get('kind')).toBe('MERCHANT_MISMATCH'));
    await userEvent.click(screen.getByRole('link', { name: '다음 실행' }));
    await screen.findByRole('heading', { name: 'VAN 대조 #4' });
    expect(screen.getByLabelText('재검증')).toHaveValue('true');
    expect(screen.getByLabelText('종류')).toHaveValue('');
    await waitFor(() => expect(calls.some((c) => c.path === '/van-reconciliations/4')).toBe(true));
    const last = calls.filter((c) => c.path === '/van-reconciliations/4').at(-1)!;
    expect(last.query.get('verified')).toBe('true');
    expect(last.query.get('kind')).toBeNull(); // 빈 값은 client가 쿼리에서 뺀다
  });

  it('진행 중(RUNNING)이면 재검증 결과가 아직 다 쌓이지 않았다고 알리고, 화면을 떠나면 다시 읽기를 멈춘다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { calls } = mockApi({
        'GET /van-reconciliations/3': () => ({ body: { ...run({ status: 'RUNNING', finishedAt: null }), items: [], nextAfterId: null } }),
      });
      const { unmount } = renderPage(<VanRunDetailPage />, { route: '/reports/van/3', path: '/reports/van/:id' });
      expect(await screen.findByText(/대조 진행 중 — 2초마다/)).toBeInTheDocument();
      expect(screen.getByText(/진행 중이라 재검증 결과가 아직 다 쌓이지 않았습니다/)).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(2_000);
      await waitFor(() => expect(calls.length).toBe(2));
      unmount();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('발주 입고 대조 (F10)', () => {
  it('발주를 고르면 대조(명세 차이·빠진 것·명세 밖)를 보여 주고, 확인하면 마감한다', async () => {
    const { calls } = mockApi({
      'GET /terminal-models': () => ({ body: [{ code: 'SN-100', name: '유선 카운터형', requiresReinspection: false }] }),
      'GET /purchase-orders': () => ({
        body: {
          items: [{ id: 5, poNo: 'SE0005', modelCode: 'SN-100', quantity: 10, status: 'RECEIVING', orderedBy: 'kim', createdAt: '2026-10-27T00:00:00.000Z', closedAt: null, closedBy: null }],
          nextBeforeId: null,
        },
      }),
      'GET /purchase-orders/SE0005/reconciliation': () => ({
        body: { poNo: 'SE0005', modelCode: 'SN-100', status: 'RECEIVING', ordered: 10, noted: 9, received: 7, shortfall: 1, missing: ['SE5-8', 'SE5-9'], unexpected: ['ZZ-1'] },
      }),
      'POST /purchase-orders/SE0005/close': () => ({ body: {} }),
    });
    loginAs();
    renderPage(<PurchaseOrdersPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'SE0005' }));
    expect(screen.getByRole('button', { name: 'SE0005' })).toHaveAttribute('aria-pressed', 'true');
    const panel = await screen.findByRole('generic', { name: '입고 대조' });
    expect(await within(panel).findByText('SE5-8, SE5-9')).toBeInTheDocument();
    expect(within(panel).getByText('ZZ-1')).toBeInTheDocument();
    expect(within(panel).getByText('(발주와 차이 1)')).toBeInTheDocument();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.click(within(panel).getByRole('button', { name: '마감' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/purchase-orders/SE0005/close' && c.method === 'POST')).toBe(true));
  });
});

describe('주간 운영 리포트 (F11, decisions/0038)', () => {
  const report = (over: Partial<WeeklyReportView> = {}): WeeklyReportView => ({
    weekStart: '2026-10-19',
    status: 'SENT',
    fileName: '단말온-주간리포트-2026-10-19.xlsx',
    fileSize: 12345,
    generatedAt: '2026-10-26T00:00:00.000Z',
    sentAt: '2026-10-26T00:00:01.000Z',
    attempts: 1,
    lastError: null,
    alreadySent: false,
    queued: false,
    queuedAt: null,
    ...over,
  });

  it('지난주 월요일(KST)을 기본으로 둔다', () => {
    expect(lastWeekMonday('2026-10-27')).toBe('2026-10-19'); // 화요일
    expect(lastWeekMonday('2026-10-26')).toBe('2026-10-19'); // 월요일
    expect(lastWeekMonday('2026-11-01')).toBe('2026-10-19'); // 일요일
  });

  it('보낼 주 검사: 월요일만, 지난주 월요일까지만(끝나지 않은 주는 서버도 422)', () => {
    expect(weekStartProblem('2026-10-19', '2026-10-19')).toBeNull();
    expect(weekStartProblem('2026-10-12', '2026-10-19')).toBeNull();
    expect(weekStartProblem('2026-10-14', '2026-10-19')).toBe('월요일을 고르세요.');
    expect(weekStartProblem('2026-10-26', '2026-10-19')).toBe('2026-10-19 주까지만 보낼 수 있습니다(끝나지 않은 주).');
    expect(weekStartProblem('', '2026-10-19')).toBe('주를 고르세요.');
  });

  it('날짜 입력은 지난주 월요일이 최대이고, 월요일이 아니거나 그 뒤의 주면 보내기를 끄고 이유를 보여 준다', async () => {
    mockApi({ 'GET /reports/weekly': () => ({ body: { items: [], nextBefore: null } }) });
    loginAs();
    renderPage(<WeeklyReportsPage />);
    const max = lastWeekMonday();
    const input = screen.getByLabelText('보낼 주');
    const button = screen.getByRole('button', { name: '보내기' });
    expect(input).toHaveAttribute('max', max);
    expect(input).toHaveValue(max);
    expect(button).toBeEnabled();
    fireEvent.change(input, { target: { value: addDays(max, -5) } }); // 수요일
    expect(button).toBeDisabled();
    expect(screen.getByText('월요일을 고르세요.')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: addDays(max, 7) } }); // 이번 주 월요일
    expect(button).toBeDisabled();
    expect(screen.getByText(`${max} 주까지만 보낼 수 있습니다(끝나지 않은 주).`)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: addDays(max, -7) } });
    expect(button).toBeEnabled();
  });

  it('목록·내려받기 링크, 못 보낸 주는 다시 보내기(202 → 대기열 표시와 다시 읽기)', async () => {
    let rows = [report(), report({ weekStart: '2026-10-12', status: 'GENERATED', fileSize: 9999, sentAt: null, attempts: 2, lastError: 'PartnerTransientError: 톡톡메신저 응답 500' })];
    const { calls } = mockApi({
      'GET /reports/weekly': () => ({ body: { items: rows, nextBefore: null } }),
      'POST /reports/weekly': (c) => {
        rows = rows.map((r) => (r.weekStart === (c.body as { weekStart: string }).weekStart ? { ...r, queued: true } : r));
        return { status: 202, body: { ...rows[1], queued: true } };
      },
    });
    loginAs();
    renderPage(<WeeklyReportsPage />);
    expect(await screen.findByRole('link', { name: 'xlsx (12,345바이트)' })).toHaveAttribute('href', '/api/reports/weekly/2026-10-19/file');
    expect(screen.getByText('PartnerTransientError: 톡톡메신저 응답 500')).toHaveClass('bad');
    await userEvent.click(screen.getByRole('button', { name: '다시 보내기' }));
    expect(await screen.findByText('대기열')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ weekStart: '2026-10-12' });
    expect(screen.getByText('2026-10-12 주: 보내기 대기열에 넣었습니다.')).toBeInTheDocument();
    expect(screen.getByText(/보내는 중 — 2초마다/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '다시 보내기' })).not.toBeInTheDocument();
  });

  it('대기 시간 표시: queuedAt부터 몇 분째인지, 10분이 넘으면 워커 확인 안내', () => {
    const now = new Date('2026-10-27T01:12:30.000Z');
    expect(queueWait('2026-10-27T01:09:59.000Z', now)).toEqual({ minutes: 2, since: '2026-10-27 10:09:59 KST', stuck: false });
    expect(queueWait('2026-10-27T01:02:30.000Z', now)).toEqual({ minutes: 10, since: '2026-10-27 10:02:30 KST', stuck: true });
    expect(queueWait('2026-10-27T01:12:40.000Z', now)?.minutes).toBe(0); // 시계가 조금 어긋나도 음수로 쓰지 않는다
    expect(queueWait(null, now)).toBeNull(); // POST 202 응답에는 queuedAt이 없다
    expect(WORKER_HINT_AFTER_MIN).toBe(10);
  });

  it('대기열에 있는 동안 지난 lastError는 숨기고 "N분째 대기"를, 10분이 넘으면 워커 확인 안내를 보여 준다', async () => {
    const queuedAt = new Date(Date.now() - 12 * 60_000 - 5_000).toISOString();
    mockApi({
      'GET /reports/weekly': () => ({
        body: {
          items: [report({ weekStart: '2026-10-12', status: 'GENERATED', sentAt: null, attempts: 2, lastError: 'PartnerTransientError: 지난 실패', queued: true, queuedAt })],
          nextBefore: null,
        },
      }),
    });
    loginAs();
    renderPage(<WeeklyReportsPage />);
    expect(await screen.findByText(/12분째 대기/)).toBeInTheDocument();
    expect(screen.queryByText('PartnerTransientError: 지난 실패')).not.toBeInTheDocument();
    expect(screen.getByText(/워커가 실행 중인지 확인하세요/)).toBeInTheDocument();
  });

  it('대기 10분 전에는 워커 안내를 보이지 않는다', async () => {
    mockApi({
      'GET /reports/weekly': () => ({
        body: { items: [report({ status: 'GENERATED', sentAt: null, queued: true, queuedAt: new Date(Date.now() - 3 * 60_000).toISOString() })], nextBefore: null },
      }),
    });
    loginAs();
    renderPage(<WeeklyReportsPage />);
    expect(await screen.findByText(/3분째 대기/)).toBeInTheDocument();
    expect(screen.queryByText(/워커가 실행 중인지 확인하세요/)).not.toBeInTheDocument();
  });

  // 회귀 방지(처음부터 통과): 2초 다시 읽기의 응답이 같아도 화면이 다시 그려져 "N분째"가 올라가야 한다.
  // 다시 그리는 원인은 대기 시간 기준으로 읽는 list.dataUpdatedAt(추적되는 결과 속성)이다(devlog 2026-10-27 Task 8 리뷰 반영).
  it('(회귀 방지) 같은 응답을 다시 읽어도 "N분째"가 올라가고, 10분이 되면 워커 안내가 나온다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const queuedAt = new Date(Date.now() - 9 * 60_000 - 30_000).toISOString();
      mockApi({
        'GET /reports/weekly': () => ({ body: { items: [report({ status: 'GENERATED', sentAt: null, queued: true, queuedAt })], nextBefore: null } }),
      });
      loginAs();
      renderPage(<WeeklyReportsPage />);
      expect(await screen.findByText(/9분째 대기/)).toBeInTheDocument();
      expect(screen.queryByText(/워커가 실행 중인지 확인하세요/)).not.toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(40_000);
      expect(await screen.findByText(/10분째 대기/)).toBeInTheDocument();
      expect(screen.getByText(/워커가 실행 중인지 확인하세요/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('다시 읽기 응답이 2초보다 늦어도 진행 중인 요청을 취소하지 않고 그 결과를 반영한다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let reads = 0;
      mockApi({
        'GET /reports/weekly': async () => {
          reads += 1;
          if (reads === 1) {
            return { body: { items: [report({ status: 'GENERATED', sentAt: null, queued: true, queuedAt: new Date().toISOString() })], nextBefore: null } };
          }
          await new Promise((resolve) => setTimeout(resolve, 3_000)); // 느린 응답(2초 폴링보다 길다)
          return { body: { items: [report()], nextBefore: null } };
        },
      });
      loginAs();
      renderPage(<WeeklyReportsPage />);
      expect(await screen.findByText(/보내는 중 — 2초마다/)).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(2_000); // 첫 다시 읽기 시작(3초 뒤 응답)
      await vi.advanceTimersByTimeAsync(2_000); // 다음 폴링: 진행 중인 요청을 취소하고 새로 부르면 안 된다
      await vi.advanceTimersByTimeAsync(1_500);
      await waitFor(() => expect(screen.queryByText(/보내는 중 — 2초마다/)).not.toBeInTheDocument());
      expect(reads).toBe(2);
      expect(screen.getByText('SENT')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('2초마다 다시 읽다가 queued가 false가 되면 멈춘다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let reads = 0;
      mockApi({
        'GET /reports/weekly': () => {
          reads += 1;
          const done = reads >= 2;
          return {
            body: {
              items: [report({ status: done ? 'SENT' : 'GENERATED', queued: !done, queuedAt: done ? null : new Date().toISOString() })],
              nextBefore: null,
            },
          };
        },
      });
      loginAs();
      renderPage(<WeeklyReportsPage />);
      expect(await screen.findByText(/보내는 중 — 2초마다/)).toBeInTheDocument();
      expect(reads).toBe(1);
      await vi.advanceTimersByTimeAsync(2_000);
      await waitFor(() => expect(screen.queryByText(/보내는 중 — 2초마다/)).not.toBeInTheDocument());
      expect(reads).toBe(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
