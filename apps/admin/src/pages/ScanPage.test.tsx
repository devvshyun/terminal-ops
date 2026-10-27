import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { loginAs, mockApi, renderPage, type Call } from '../test/render';
import { parseSerials, ScanPage } from './ScanPage';

const orderRows = [
  { id: 3, poNo: 'SE0003', modelCode: 'SN-100', quantity: 50, status: 'RECEIVING' },
  { id: 2, poNo: 'SE0002', modelCode: 'SN-200', quantity: 10, status: 'CLOSED' },
];
/** ?status=가 있으면 그 상태만(서버 GET /purchase-orders와 같게) */
const orders = {
  'GET /purchase-orders': (c: Call) => ({
    body: { items: orderRows.filter((p) => !c.query.get('status') || p.status === c.query.get('status')), nextBeforeId: null },
  }),
};

const result = (body: { scanId: string; kind: string; poNo?: string; serials: string[] }, replayed: boolean) => ({
  scanId: body.scanId,
  kind: body.kind,
  poNo: body.poNo ?? null,
  actor: '김운영',
  replayed,
  createdAt: '2026-10-27T01:00:00.000Z',
  summary: { CREATED: 1, NOT_IN_DELIVERY_NOTE: 1 },
  results: [
    { serialNo: body.serials[0], result: 'CREATED' },
    { serialNo: body.serials[1], result: 'NOT_IN_DELIVERY_NOTE', message: '발주 SE0003의 납품 명세에 없는 시리얼입니다.' },
  ],
});
const bodyOf = (c: Call) => c.body as { scanId: string; kind: string; poNo?: string; serials: string[] };
const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST');

describe('박스 스캔 (F6, decisions/0020)', () => {
  it('붙여 넣은 글을 시리얼 목록으로(줄·쉼표·공백, 빈 줄 제외, 순서 유지)', () => {
    expect(parseSerials('A-0001\n\n A-0002 ,A-0003\r\nA-0001')).toEqual(['A-0001', 'A-0002', 'A-0003', 'A-0001']);
  });

  it('발주분 입고: 마감 안 된 발주만 고르고, 처음 보낼 때 scanId를 만들어 행별 결과를 보여 준다. 보낸 박스는 고칠 수 없다', async () => {
    const { calls } = mockApi({ ...orders, 'POST /scans': (c) => ({ status: 201, body: result(bodyOf(c), false) }) });
    loginAs();
    renderPage(<ScanPage />);
    await screen.findByRole('option', { name: /SE0003/ });
    expect(screen.queryByRole('option', { name: /SE0002/ })).not.toBeInTheDocument(); // CLOSED
    await userEvent.selectOptions(screen.getByLabelText('발주'), 'SE0003');
    await userEvent.type(screen.getByLabelText('시리얼'), 'AA-0001{enter}{enter}AA-0002{enter}');
    expect(screen.getByText('2개')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));

    expect(await screen.findByText('NOT_IN_DELIVERY_NOTE')).toHaveClass('bad');
    expect(screen.getByText('CREATED')).toHaveClass('ok');
    const body = bodyOf(posts(calls)[0]);
    expect(body).toEqual({ scanId: expect.stringMatching(/^BOX-[0-9a-f-]{36}$/), kind: 'RECEIVE', poNo: 'SE0003', serials: ['AA-0001', 'AA-0002'] });
    expect(screen.getByLabelText('scanId')).toHaveTextContent(body.scanId);
    expect(screen.getByLabelText('시리얼')).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();
  });

  it('응답을 못 받으면(처리 중 409·5xx) 같은 scanId로 다시 보낸다 — 두 번째는 저장된 결과(replayed)', async () => {
    let n = 0;
    const { calls } = mockApi({
      'POST /scans': (c) => {
        n += 1;
        if (n === 1) return { status: 409, body: { statusCode: 409, code: 'SCAN_IN_PROGRESS', message: '처리하는 중입니다.' } };
        return { status: 200, body: result(bodyOf(c), true) };
      },
    });
    loginAs();
    renderPage(<ScanPage />);
    await userEvent.click(screen.getByLabelText(/회수 입고/));
    await userEvent.type(screen.getByLabelText('시리얼'), 'RT-0001 RT-0002');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('SCAN_IN_PROGRESS');
    await userEvent.click(screen.getByRole('button', { name: '같은 scanId로 다시 보내기' }));
    expect(await screen.findByText('이미 처리된 박스 — 저장된 결과')).toBeInTheDocument();
    const [first, second] = posts(calls).map(bodyOf);
    expect(second.scanId).toBe(first.scanId);
    expect(first).toEqual({ scanId: first.scanId, kind: 'RETURN_IN', serials: ['RT-0001', 'RT-0002'] }); // 회수 입고는 poNo를 보내지 않는다
  });

  it('입력 오류(400 등)면 scanId를 버린다 — 고친 뒤 보내면 새 scanId', async () => {
    let n = 0;
    const { calls } = mockApi({
      'POST /scans': (c) => {
        n += 1;
        return n === 1
          ? { status: 400, body: { statusCode: 400, message: ['serials must contain no more than 500 elements'] } }
          : { status: 201, body: result(bodyOf(c), false) };
      },
    });
    loginAs();
    renderPage(<ScanPage />);
    await userEvent.click(screen.getByLabelText(/회수 입고/));
    await userEvent.type(screen.getByLabelText('시리얼'), 'RT-0001 RT-0002');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('입력값을 확인하세요');
    expect(screen.getByLabelText('시리얼')).not.toHaveAttribute('readonly');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    expect(bodyOf(posts(calls)[1]).scanId).not.toBe(bodyOf(posts(calls)[0]).scanId);
  });

  it('로그인 정보가 없으면 보내기가 꺼진다', async () => {
    mockApi({});
    renderPage(<ScanPage />);
    await userEvent.click(screen.getByLabelText(/회수 입고/));
    await userEvent.type(screen.getByLabelText('시리얼'), 'RT-0001');
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();
  });
});

/** POST /scans를 release()를 부를 때까지 붙잡아 둔다(보내는 중 상태를 보려고) */
function holdPosts(fetchMock: ReturnType<typeof mockApi>['fetchMock']) {
  const original = fetchMock.getMockImplementation()!;
  const held: (() => void)[] = [];
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') await new Promise<void>((resolve) => held.push(resolve));
    return original(input, init);
  });
  return { release: () => held.splice(0).forEach((r) => r()) };
}

describe('박스 스캔 리뷰 반영 (Task 6 리뷰)', () => {
  it('열린 발주는 ORDERED·RECEIVING을 따로 불러 합친다(최근순) — 닫힌 발주가 100개 넘게 쌓여도 오래된 열린 발주가 보인다', async () => {
    const closed = Array.from({ length: 100 }, (_, i) => ({ id: 200 - i, poNo: `SE${200 - i}`, modelCode: 'SN-100', quantity: 1, status: 'CLOSED' }));
    const { calls } = mockApi({
      'GET /purchase-orders': (c) => {
        const status = c.query.get('status');
        if (status === 'ORDERED') return { body: { items: [{ id: 1, poNo: 'SE0001', modelCode: 'SN-100', quantity: 5, status: 'ORDERED' }], nextBeforeId: null } };
        if (status === 'RECEIVING') return { body: { items: [{ id: 7, poNo: 'SE0007', modelCode: 'SN-200', quantity: 9, status: 'RECEIVING' }], nextBeforeId: null } };
        return { body: { items: closed, nextBeforeId: 101 } };
      },
    });
    loginAs();
    renderPage(<ScanPage />);
    expect(await screen.findByRole('option', { name: /SE0001/ })).toBeInTheDocument();
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual(['발주 선택', 'SE0007 SN-200 9대 (RECEIVING)', 'SE0001 SN-100 5대 (ORDERED)']);
    const statuses = calls.filter((c) => c.path === '/purchase-orders').map((c) => c.query.get('status'));
    expect(new Set(statuses)).toEqual(new Set(['ORDERED', 'RECEIVING']));
  });

  it('스캔이 성공하면 발주 목록도 다시 읽는다(입고로 ORDERED → RECEIVING)', async () => {
    const { calls } = mockApi({ ...orders, 'POST /scans': (c) => ({ status: 201, body: result(bodyOf(c), false) }) });
    loginAs();
    renderPage(<ScanPage />);
    await screen.findByRole('option', { name: /SE0003/ });
    await userEvent.selectOptions(screen.getByLabelText('발주'), 'SE0003');
    const before = calls.filter((c) => c.path === '/purchase-orders').length;
    await userEvent.type(screen.getByLabelText('시리얼'), 'AA-0001 AA-0002');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await screen.findByText('NOT_IN_DELIVERY_NOTE');
    await waitFor(() => expect(calls.filter((c) => c.path === '/purchase-orders').length).toBeGreaterThan(before));
  });

  it('스캔이 성공하면 발주 입고 대조와 단말기 상세 캐시도 무효화한다(Day 6 최종 리뷰 Minor 4)', async () => {
    mockApi({ ...orders, 'POST /scans': (c) => ({ status: 201, body: result(bodyOf(c), false) }) });
    loginAs();
    const { client } = renderPage(<ScanPage />);
    client.setQueryData(['purchase-order', 'SE0003', 'reconciliation'], { poNo: 'SE0003' });
    client.setQueryData(['terminal', 'AA-0001', 'detail'], { serialNo: 'AA-0001' });
    await screen.findByRole('option', { name: /SE0003/ });
    await userEvent.selectOptions(screen.getByLabelText('발주'), 'SE0003');
    await userEvent.type(screen.getByLabelText('시리얼'), 'AA-0001 AA-0002');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await screen.findByText('NOT_IN_DELIVERY_NOTE');
    await waitFor(() => expect(client.getQueryState(['purchase-order', 'SE0003', 'reconciliation'])?.isInvalidated).toBe(true));
    expect(client.getQueryState(['terminal', 'AA-0001', 'detail'])?.isInvalidated).toBe(true);
  });

  it('보내는 중에는 새 박스가 꺼지고, 결과를 못 받은 박스를 버릴 때는 확인을 받는다', async () => {
    const { calls, fetchMock } = mockApi({ 'POST /scans': () => ({ status: 503, body: { statusCode: 503, message: '잠시 뒤' } }) });
    const { release } = holdPosts(fetchMock);
    const confirm = vi.spyOn(window, 'confirm');
    loginAs();
    renderPage(<ScanPage />);
    await userEvent.click(screen.getByLabelText(/회수 입고/));
    await userEvent.type(screen.getByLabelText('시리얼'), 'RT-0001');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)); // 붙잡힌 요청(calls에는 아직 없다)
    expect(screen.getByRole('button', { name: '새 박스' })).toBeDisabled();
    release();
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 503');
    const scanId = bodyOf(posts(calls)[0]).scanId;

    confirm.mockReturnValueOnce(false);
    await userEvent.click(screen.getByRole('button', { name: '새 박스' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('결과를 받지 못한 박스입니다'));
    expect(screen.getByLabelText('scanId')).toHaveTextContent(scanId); // 취소하면 그대로
    expect(screen.getByLabelText('시리얼')).toHaveValue('RT-0001');

    confirm.mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: '새 박스' }));
    expect(screen.queryByLabelText('scanId')).not.toBeInTheDocument();
    expect(screen.getByLabelText('시리얼')).toHaveValue('');
    expect(screen.getByLabelText('시리얼')).not.toHaveAttribute('readonly');
    confirm.mockRestore();
  });

  it('409 VERSION_CONFLICT(회수 박스 되돌림)는 같은 scanId로 다시 보낼 수 있다', async () => {
    let n = 0;
    const { calls } = mockApi({
      'POST /scans': (c) => {
        n += 1;
        return n === 1
          ? { status: 409, body: { statusCode: 409, code: 'VERSION_CONFLICT', message: '버전 충돌' } }
          : { status: 201, body: result(bodyOf(c), false) };
      },
    });
    loginAs();
    renderPage(<ScanPage />);
    await userEvent.click(screen.getByLabelText(/회수 입고/));
    await userEvent.type(screen.getByLabelText('시리얼'), 'RT-0001 RT-0002');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('VERSION_CONFLICT');
    expect(screen.getByText(/박스 전체가 되돌려졌습니다/)).toBeInTheDocument();
    expect(screen.getByLabelText('시리얼')).toHaveAttribute('readonly');
    await userEvent.click(screen.getByRole('button', { name: '같은 scanId로 다시 보내기' }));
    await screen.findByText('CREATED');
    const [first, second] = posts(calls).map(bodyOf);
    expect(second.scanId).toBe(first.scanId);
  });

  it('5xx·연결 실패도 같은 scanId로 다시 보내고, 다시 보낸 것도 실패하면 박스는 계속 고칠 수 없다(회귀 방지)', async () => {
    let n = 0;
    const { calls, fetchMock } = mockApi({
      'POST /scans': (c) => {
        n += 1;
        return n === 1 ? { status: 502, body: { statusCode: 502, message: 'Bad Gateway' } } : { status: 200, body: result(bodyOf(c), true) };
      },
    });
    const original = fetchMock.getMockImplementation()!;
    let failNext = false;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST' && failNext) {
        failNext = false;
        calls.push({ method: 'POST', path: '/scans', query: new URLSearchParams(), body: JSON.parse(String(init.body)), headers: {} });
        throw new TypeError('Failed to fetch');
      }
      return original(input, init);
    });
    loginAs();
    renderPage(<ScanPage />);
    await userEvent.click(screen.getByLabelText(/회수 입고/));
    await userEvent.type(screen.getByLabelText('시리얼'), 'RT-0001 RT-0002');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 502');
    failNext = true;
    await userEvent.click(screen.getByRole('button', { name: '같은 scanId로 다시 보내기' }));
    expect(await screen.findByText('서버에 연결하지 못했습니다. api가 떠 있는지 확인하세요.')).toBeInTheDocument();
    expect(screen.getByLabelText('시리얼')).toHaveAttribute('readonly');
    await userEvent.click(screen.getByRole('button', { name: '같은 scanId로 다시 보내기' }));
    expect(await screen.findByText('이미 처리된 박스 — 저장된 결과')).toBeInTheDocument();
    const ids = posts(calls).map((c) => bodyOf(c).scanId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
  });

  it('결과를 받은 뒤 새 박스는 확인 없이 비우고, 다음 박스는 새 scanId(회귀 방지)', async () => {
    const { calls } = mockApi({ 'POST /scans': (c) => ({ status: 201, body: result(bodyOf(c), false) }) });
    const confirm = vi.spyOn(window, 'confirm');
    loginAs();
    renderPage(<ScanPage />);
    await userEvent.click(screen.getByLabelText(/회수 입고/));
    await userEvent.type(screen.getByLabelText('시리얼'), 'RT-0001 RT-0002');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await screen.findByText('CREATED');
    await userEvent.click(screen.getByRole('button', { name: '새 박스' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByLabelText('시리얼')).toHaveValue('');
    expect(screen.queryByText('CREATED')).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('시리얼'), 'RT-0003 RT-0004');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    expect(bodyOf(posts(calls)[1]).scanId).not.toBe(bodyOf(posts(calls)[0]).scanId);
    confirm.mockRestore();
  });

  it('501개면 보내기가 꺼지고 안내, 발주분 입고는 발주를 고르기 전까지 꺼진다(회귀 방지)', async () => {
    mockApi(orders);
    loginAs();
    const { container } = renderPage(<ScanPage />);
    await screen.findByRole('option', { name: /SE0003/ });
    await userEvent.type(screen.getByLabelText('시리얼'), 'AA-0001');
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled(); // 발주 미선택
    await userEvent.selectOptions(screen.getByLabelText('발주'), 'SE0003');
    expect(screen.getByRole('button', { name: '보내기' })).toBeEnabled();
    const many = Array.from({ length: 501 }, (_, i) => `BB-${String(i).padStart(4, '0')}`).join('\n');
    await userEvent.clear(screen.getByLabelText('시리얼'));
    await userEvent.click(screen.getByLabelText('시리얼'));
    await userEvent.paste(many);
    expect(screen.getByText('501개')).toBeInTheDocument();
    expect(screen.getByText('한 박스는 500개까지입니다.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();
    expect(container).toBeTruthy();
  });

  it('보내기 전에 중복 시리얼 수를 보여 준다', async () => {
    mockApi({});
    loginAs();
    renderPage(<ScanPage />);
    await userEvent.click(screen.getByLabelText(/회수 입고/));
    await userEvent.type(screen.getByLabelText('시리얼'), 'RT-0001 RT-0002 RT-0001 RT-0001');
    expect(screen.getByText('4개')).toBeInTheDocument();
    expect(screen.getByText('중복 2개')).toBeInTheDocument();
  });
});
