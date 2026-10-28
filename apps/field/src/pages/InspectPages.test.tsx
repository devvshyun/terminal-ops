import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { InspectRequest, TerminalDetail, TerminalStatus, TerminalView } from '@terminal-ops/contracts';
import { keys } from '../api/query-keys';
import { loginAs, mockApi, renderApp, type Call } from '../test/render';

const view = (serialNo: string, status: TerminalStatus, statusChangedAt: string): TerminalView => ({
  serialNo,
  modelCode: 'SN-100',
  merchantCode: null,
  status,
  statusChangedAt,
  version: 1,
  createdAt: statusChangedAt,
  updatedAt: statusChangedAt,
});
const detail = (serialNo: string, status: TerminalStatus = 'RECEIVED'): TerminalDetail => ({
  ...view(serialNo, status, '2026-10-28T00:00:00.000Z'),
  modelName: '단말온 S100',
  merchantName: null,
  allowedTransitions: [],
  actions: { allocate: false, cancelAllocation: false, ship: false, inspect: status === 'RECEIVED' || status === 'RETURNED' },
});
const ITEMS = [
  { code: 'POWER', label: '전원', sortOrder: 1 },
  { code: 'NETWORK', label: '통신', sortOrder: 2 },
  { code: 'CARD_READER', label: '카드 리더', sortOrder: 3 },
  { code: 'PRINTER', label: '프린터', sortOrder: 4 },
];
/** 검수 대기 목록: 상태별로 다른 단말기(서버 GET /terminals?status=와 같게 그 상태만) */
const queue = (byStatus: Partial<Record<TerminalStatus, TerminalView[]>>, totals: Partial<Record<TerminalStatus, number>> = {}) => ({
  'GET /terminals': (c: Call) => {
    const status = c.query.get('status') as TerminalStatus;
    const items = byStatus[status] ?? [];
    return { body: { items, total: totals[status] ?? items.length, page: 1, size: Number(c.query.get('size')) } };
  },
});
const today = { 'GET /field/today': () => ({ body: { date: '2026-10-28', scans: { boxes: 0, received: 0, returned: 0, rejected: 0 }, inspections: { total: 0, passed: 0, failed: 0 } } }) };

describe('검수 대기 (보강 4)', () => {
  it('새 입고·회수 입고를 상태마다 불러 합치고 오래 기다린 것부터 보인다', async () => {
    const { calls } = mockApi(
      queue({
        RECEIVED: [view('SN-NEW-2', 'RECEIVED', '2026-10-28T02:00:00.000Z'), view('SN-NEW-1', 'RECEIVED', '2026-10-28T01:00:00.000Z')],
        RETURNED: [view('SN-RET-1', 'RETURNED', '2026-10-27T23:00:00.000Z')],
      }),
    );
    loginAs();
    renderApp('/inspections');
    expect(await screen.findByRole('heading', { name: '검수 대기 3대' })).toBeInTheDocument();
    const links = within(screen.getByRole('list')).getAllByRole('link');
    expect(links.map((a) => a.querySelector('.serial')?.textContent)).toEqual(['SN-RET-1', 'SN-NEW-1', 'SN-NEW-2']);
    expect(links[0]).toHaveTextContent('회수 입고');
    expect(links[0]).toHaveTextContent('SN-100 · 10-28 08:00부터');
    expect(links[1]).toHaveTextContent('새 입고');
    expect(links[0]).toHaveAttribute('href', '/inspections/SN-RET-1');
    expect(calls.filter((c) => c.path === '/terminals').map((c) => c.query.toString())).toEqual(['status=RECEIVED&size=100', 'status=RETURNED&size=100']);
  });

  it('상태별 100대를 넘으면 잘렸다고 알린다. 없으면 없다고', async () => {
    mockApi(queue({ RECEIVED: [view('SN-1', 'RECEIVED', '2026-10-28T01:00:00.000Z')] }, { RECEIVED: 130 }));
    loginAs();
    const first = renderApp('/inspections');
    expect(await screen.findByText('130대 중 오래 기다린 순으로 1대만 보입니다(상태별 최근 100대).')).toBeInTheDocument();
    first.unmount();
    mockApi(queue({}));
    renderApp('/inspections');
    expect(await screen.findByText('검수할 단말기가 없습니다.')).toBeInTheDocument();
  });

  it('손에 든 단말기를 스캔하면(글자 + Enter) 그 단말기 검수 화면으로 간다', async () => {
    const { calls } = mockApi({ ...queue({}), 'GET /terminals/:serialNo': () => ({ body: detail('SN-HAND-1') }), 'GET /inspection-items': () => ({ body: ITEMS }) });
    loginAs();
    renderApp('/inspections');
    await screen.findByText('검수할 단말기가 없습니다.');
    expect(screen.getByLabelText('시리얼 스캔으로 찾기')).toHaveFocus();
    await userEvent.keyboard(' SN-HAND-1 {Enter}');
    expect(await screen.findByRole('heading', { name: 'SN-HAND-1' })).toBeInTheDocument();
    expect(await screen.findByRole('group', { name: '전원' })).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/terminals/SN-HAND-1')).toBe(true);
    expect(calls.find((c) => c.path === '/inspection-items')?.query.get('modelCode')).toBe('SN-100');
  });
});

describe('단말기 검수 (보강 4)', () => {
  it('항목마다 합격/불합격을 다 골라야 저장된다. 불합격 항목만 메모를 보내고, 결과(불량)와 다음 단말기 버튼을 보인다', async () => {
    const { calls } = mockApi({
      ...today,
      ...queue({}),
      'GET /terminals/:serialNo': () => ({ body: detail('SN-0001') }),
      'GET /inspection-items': () => ({ body: ITEMS }),
      'POST /terminals/:serialNo/inspections': () => ({
        status: 201,
        body: { inspectionId: 9, passed: false, failedItems: ['PRINTER'], terminal: view('SN-0001', 'DEFECTIVE', '2026-10-28T03:00:00.000Z') },
      }),
    });
    loginAs();
    const { client } = renderApp('/inspections/SN-0001');
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    expect(await screen.findByText('단말온 S100(SN-100) · 입고')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '남은 항목 4개' })).toBeDisabled();
    for (const label of ['전원', '통신', '카드 리더']) {
      await userEvent.click(within(screen.getByRole('group', { name: label })).getByRole('button', { name: '합격' }));
    }
    await userEvent.click(within(screen.getByRole('group', { name: '프린터' })).getByRole('button', { name: '불합격' }));
    expect(within(screen.getByRole('group', { name: '프린터' })).getByRole('button', { name: '불합격' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.type(screen.getByLabelText('프린터 메모'), ' 용지 걸림 ');
    expect(screen.queryByLabelText('전원 메모')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '검수 결과 저장' }));

    expect(await screen.findByRole('status')).toHaveTextContent('불합격 — 불량으로 바뀜불합격 항목: 프린터');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/terminals/SN-0001/inspections');
    expect(post?.body).toEqual({
      results: [
        { itemCode: 'POWER', passed: true },
        { itemCode: 'NETWORK', passed: true },
        { itemCode: 'CARD_READER', passed: true },
        { itemCode: 'PRINTER', passed: false, note: '용지 걸림' },
      ],
    } satisfies InspectRequest);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.queue });
    await userEvent.click(screen.getByRole('link', { name: '다음 단말기' }));
    expect(await screen.findByLabelText('시리얼 스캔으로 찾기')).toHaveFocus(); // 다음 단말기를 바로 스캔
  });

  it('모두 합격 한 번으로 고르고 저장하면 합격. 합격 항목의 메모는 보내지 않는다', async () => {
    const { calls } = mockApi({
      ...today,
      ...queue({}),
      'GET /terminals/:serialNo': () => ({ body: detail('SN-0002', 'RETURNED') }),
      'GET /inspection-items': () => ({ body: ITEMS }),
      'POST /terminals/:serialNo/inspections': () => ({ status: 201, body: { inspectionId: 10, passed: true, failedItems: [], terminal: view('SN-0002', 'INSPECTED', '2026-10-28T03:00:00.000Z') } }),
    });
    loginAs();
    renderApp('/inspections/SN-0002');
    await userEvent.click(within(await screen.findByRole('group', { name: '프린터' })).getByRole('button', { name: '불합격' }));
    await userEvent.type(screen.getByLabelText('프린터 메모'), '다시 보니 괜찮음');
    await userEvent.click(screen.getByRole('button', { name: '모두 합격' }));
    expect(screen.queryByLabelText('프린터 메모')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '검수 결과 저장' }));
    expect(await screen.findByRole('status')).toHaveTextContent('합격 — 검수 완료');
    expect((calls.find((c) => c.method === 'POST')?.body as InspectRequest).results.every((r) => r.passed && r.note === undefined)).toBe(true);
  });

  it('검수 대기가 아닌 단말기는 안내만(항목을 부르지 않는다), 없는 시리얼은 찾는 단말기가 없다고', async () => {
    const { calls } = mockApi({
      'GET /terminals/:serialNo': (c) =>
        c.path.endsWith('SN-STOCK') ? { body: detail('SN-STOCK', 'IN_STOCK') } : { status: 404, body: { statusCode: 404, message: '단말기 NOPE이(가) 없습니다.' } },
    });
    loginAs();
    const first = renderApp('/inspections/SN-STOCK');
    expect(await screen.findByText('검수 대기 단말기가 아닙니다(지금 상태: 재고). 다른 단말기를 스캔하세요.')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/inspection-items')).toBe(false);
    first.unmount();
    renderApp('/inspections/NOPE');
    expect(await screen.findByRole('alert')).toHaveTextContent('찾는 단말기·자료가 없습니다.');
  });

  it('저장이 실패하면(그새 다른 사람이 검수 — 422) 단말기를 다시 읽어 검수 대기가 아니라는 안내와 지금 상태를 보인다', async () => {
    let state: TerminalStatus = 'RECEIVED';
    const { calls } = mockApi({
      ...today,
      ...queue({}),
      'GET /terminals/:serialNo': () => ({ body: detail('SN-0003', state) }),
      'GET /inspection-items': () => ({ body: ITEMS }),
      'POST /terminals/:serialNo/inspections': () => {
        state = 'INSPECTED';
        return { status: 422, body: { statusCode: 422, code: 'INVALID_TRANSITION', message: '허용되지 않은 전이입니다: INSPECTED → INSPECTED' } };
      },
    });
    loginAs();
    renderApp('/inspections/SN-0003');
    await userEvent.click(await screen.findByRole('button', { name: '모두 합격' }));
    await userEvent.click(screen.getByRole('button', { name: '검수 결과 저장' }));
    expect(await screen.findByText('검수 대기 단말기가 아닙니다(지금 상태: 검수 합격). 그새 다른 사람이 검수했을 수 있습니다. 다른 단말기를 스캔하세요.')).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((c) => c.path === '/terminals/SN-0003')).toHaveLength(2));
    // 검수 화면(체크리스트)이 사라져도 실패는 남는다 — 저장이 안 된 것을 모르고 지나가지 않게
    expect(screen.getByRole('alert')).toHaveTextContent('방금 저장하지 못했습니다: 지금 상태에서는 할 수 없습니다. 이미 처리됐는지 확인하세요.');
    expect(screen.getByRole('alert')).toHaveTextContent('허용되지 않은 전이입니다: INSPECTED → INSPECTED');
    // 스캐너가 갈 곳: 시리얼 칸에 초점, 다음 단말기를 바로 스캔
    expect(screen.getByLabelText('시리얼 스캔으로 찾기')).toHaveFocus();
  });

  it('저장 결과를 받지 못했으면(연결 실패·5xx) 서버가 저장했을 수 있다고 안내한다 — 그새 다른 사람이 검수했다는 말은 하지 않는다', async () => {
    const failures: Array<() => { status: number; body: unknown }> = [
      () => {
        throw new TypeError('Failed to fetch'); // 연결 실패: 가짜 fetch가 거부된다
      },
      () => ({ status: 503, body: { statusCode: 503, message: '잠시 쉬는 중' } }),
    ];
    for (const failure of failures) {
      let state: TerminalStatus = 'RECEIVED';
      mockApi({
        ...today,
        ...queue({}),
        'GET /terminals/:serialNo': () => ({ body: detail('SN-0005', state) }),
        'GET /inspection-items': () => ({ body: ITEMS }),
        'POST /terminals/:serialNo/inspections': () => {
          state = 'INSPECTED'; // 서버는 저장했는데 응답이 오지 않은 경우
          return failure();
        },
      });
      loginAs();
      const view = renderApp('/inspections/SN-0005');
      await userEvent.click(await screen.findByRole('button', { name: '모두 합격' }));
      await userEvent.click(screen.getByRole('button', { name: '검수 결과 저장' }));
      expect(
        await screen.findByText('검수 대기 단말기가 아닙니다(지금 상태: 검수 합격). 결과를 받지 못했습니다 — 지금 상태가 검수 합격·불량이면 저장된 것입니다(검수 기록에서 확인). 다른 단말기를 스캔하세요.'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/그새 다른 사람이/)).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('검수 대기가 아닌 화면과 저장 결과 화면에서 다음 시리얼을 바로 스캔해 그 단말기로 간다', async () => {
    mockApi({
      ...today,
      ...queue({}),
      'GET /terminals/:serialNo': (c) => ({ body: detail(decodeURIComponent(c.path.split('/').pop() ?? ''), c.path.endsWith('SN-STOCK') ? 'IN_STOCK' : 'RECEIVED') }),
      'GET /inspection-items': () => ({ body: ITEMS }),
      'POST /terminals/:serialNo/inspections': () => ({ status: 201, body: { inspectionId: 11, passed: true, failedItems: [], terminal: view('SN-0004', 'INSPECTED', '2026-10-28T03:00:00.000Z') } }),
    });
    loginAs();
    renderApp('/inspections/SN-STOCK');
    await screen.findByText(/검수 대기 단말기가 아닙니다/);
    expect(screen.getByLabelText('시리얼 스캔으로 찾기')).toHaveFocus();
    await userEvent.keyboard('SN-0004{Enter}');
    await userEvent.click(await screen.findByRole('button', { name: '모두 합격' }));
    await userEvent.click(screen.getByRole('button', { name: '검수 결과 저장' }));
    expect(await screen.findByRole('status')).toHaveTextContent('합격 — 검수 완료');
    expect(screen.getByLabelText('시리얼 스캔으로 찾기')).toHaveFocus();
    await userEvent.keyboard('SN-0005{Enter}');
    expect(await screen.findByRole('heading', { name: 'SN-0005' })).toBeInTheDocument();
    expect(await screen.findByRole('group', { name: '전원' })).toBeInTheDocument();
  });

  it('검수 항목이 없는 모델은 저장할 수 없다고 안내한다', async () => {
    mockApi({ 'GET /terminals/:serialNo': () => ({ body: detail('SN-0006') }), 'GET /inspection-items': () => ({ body: [] }) });
    loginAs();
    renderApp('/inspections/SN-0006');
    expect(await screen.findByText('이 모델은 검수 항목이 없습니다. 어드민에서 확인하세요.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /검수 결과 저장|남은 항목/ })).not.toBeInTheDocument();
  });

  it('저장 뒤에는 오늘 요약·검수 대기·그 단말기만 다시 읽는다(검수 항목은 그대로)', async () => {
    mockApi({
      ...today,
      ...queue({}),
      'GET /terminals/:serialNo': () => ({ body: detail('SN-0007') }),
      'GET /inspection-items': () => ({ body: ITEMS }),
      'POST /terminals/:serialNo/inspections': () => ({ status: 201, body: { inspectionId: 12, passed: true, failedItems: [], terminal: view('SN-0007', 'INSPECTED', '2026-10-28T03:00:00.000Z') } }),
    });
    loginAs();
    const { client } = renderApp('/inspections/SN-0007');
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await userEvent.click(await screen.findByRole('button', { name: '모두 합격' }));
    await userEvent.click(screen.getByRole('button', { name: '검수 결과 저장' }));
    await screen.findByRole('status');
    const called = invalidate.mock.calls.map((c) => c[0]?.queryKey);
    expect(called).toEqual(expect.arrayContaining([keys.today, keys.queue, keys.terminal('SN-0007')]));
    expect(called).not.toContainEqual(keys.all);
  });
});
