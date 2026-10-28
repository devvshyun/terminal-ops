import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CreateScanRequest, ScanView } from '@terminal-ops/contracts';
import { keys } from '../api/query-keys';
import { loginAs, mockApi, renderPage, type Call } from '../test/render';
import { ScanPage } from './ScanPage';

const orderRows = [
  { id: 3, poNo: 'SE0003', modelCode: 'SN-100', quantity: 50, status: 'RECEIVING' },
  { id: 4, poNo: 'SE0004', modelCode: 'SN-200', quantity: 10, status: 'ORDERED' },
];
/** ?status=가 있으면 그 상태만(서버 GET /purchase-orders와 같게) */
const orders = {
  'GET /purchase-orders': (c: Call) => ({ body: { items: orderRows.filter((p) => p.status === c.query.get('status')), nextBeforeId: null } }),
};
const bodyOf = (c: Call) => c.body as CreateScanRequest;
const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST');
/** 서버처럼: 첫 줄은 CREATED(회수면 RETURNED), 나머지는 명세 밖. 화면은 summary 대신 행 결과로 센다 */
const result = (body: CreateScanRequest, replayed: boolean): ScanView => {
  const ok = body.kind === 'RECEIVE' ? 'CREATED' : 'RETURNED';
  const results = body.serials.map((serialNo, i) =>
    i === 0 ? { serialNo, result: ok } : { serialNo, result: 'NOT_IN_DELIVERY_NOTE' as const, message: '납품 명세에 없는 시리얼입니다.' },
  );
  return { scanId: body.scanId, kind: body.kind, poNo: body.poNo ?? null, actor: 'field', replayed, createdAt: '2026-10-28T01:00:00.000Z', summary: {}, results } as ScanView;
};
const rows = () => within(screen.getByRole('list', { name: '박스 목록' })).queryAllByRole('listitem');

/** 바코드 스캐너(키보드 웨지): 초점이 있는 칸에 글자를 치고 Enter. 클릭 없이 keyboard만 쓴다 — 처음부터 입력칸에 초점이 있어야 한다 */
const scanBarcode = (serial: string) => userEvent.keyboard(`${serial}{Enter}`);

describe('박스 스캔 — 스캐너 입력 (보강 4, decisions/0064)', () => {
  it('스캐너가 찍을 때마다(글자 + Enter) 목록에 쌓이고 입력칸이 비며 초점이 그대로다. 중복·형식 오류는 그 줄에 표시', async () => {
    mockApi(orders);
    loginAs();
    renderPage(<ScanPage />);
    const field = screen.getByLabelText(/시리얼/);
    expect(field).toHaveFocus();
    await scanBarcode('SN-0001');
    await scanBarcode('SN-0002');
    await scanBarcode('SN-0001');
    await scanBarcode('bad');
    expect(rows().map((r) => r.textContent)).toEqual(['SN-0001빼기', 'SN-0002빼기', 'SN-0001중복빼기', 'bad형식 오류빼기']);
    expect(field).toHaveValue('');
    expect(field).toHaveFocus();
    expect(screen.getByText('4개')).toBeInTheDocument();
    expect(screen.getByText(/중복 1/)).toBeInTheDocument();
    expect(screen.getByText(/형식 오류 1/)).toBeInTheDocument();
  });

  it('손으로 쳐서 추가 버튼, 여러 개를 한 번에 붙여 넣기, 빈 Enter는 무시, 잘못 찍은 줄은 빼기', async () => {
    mockApi(orders);
    loginAs();
    renderPage(<ScanPage />);
    await userEvent.type(screen.getByLabelText(/시리얼/), 'SN-0009');
    await userEvent.click(screen.getByRole('button', { name: '추가' }));
    await userEvent.click(screen.getByLabelText(/시리얼/));
    await userEvent.paste('SN-0010 SN-0011\nSN-0012');
    await userEvent.keyboard('{Enter}{Enter}');
    expect(rows().map((r) => r.querySelector('.serial')?.textContent)).toEqual(['SN-0009', 'SN-0010', 'SN-0011', 'SN-0012']);
    await userEvent.click(screen.getByRole('button', { name: 'SN-0010 빼기' }));
    expect(rows().map((r) => r.querySelector('.serial')?.textContent)).toEqual(['SN-0009', 'SN-0011', 'SN-0012']);
  });

  it('공백 없는 시리얼 하나를 붙여 넣고 Enter를 치면 그 하나가 목록에 쌓인다(붙여 넣기가 입력칸에 글자로 들어가고 Enter가 더한다)', async () => {
    mockApi(orders);
    loginAs();
    renderPage(<ScanPage />);
    await userEvent.click(screen.getByLabelText(/시리얼/));
    await userEvent.paste('SN-0020');
    expect(rows()).toHaveLength(0);
    expect(screen.getByLabelText(/시리얼/)).toHaveValue('SN-0020');
    await userEvent.keyboard('{Enter}');
    expect(rows().map((r) => r.querySelector('.serial')?.textContent)).toEqual(['SN-0020']);
    expect(screen.getByLabelText(/시리얼/)).toHaveValue('');
  });

  it('501개면 보내기가 꺼지고 안내, 발주분 입고는 발주를 고르기 전까지 꺼진다', async () => {
    mockApi(orders);
    loginAs();
    renderPage(<ScanPage />);
    await userEvent.click(screen.getByLabelText(/시리얼/));
    await userEvent.paste(Array.from({ length: 501 }, (_, i) => `SN-${String(i).padStart(4, '0')}`).join('\n'));
    await userEvent.keyboard('{Enter}');
    expect(screen.getByText(/한 박스는 500개까지입니다/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'SN-0500 빼기' }));
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled(); // 발주를 아직 안 골랐다
    await screen.findByRole('option', { name: /SE0003/ });
    await userEvent.selectOptions(screen.getByLabelText('발주'), 'SE0003');
    expect(screen.getByRole('button', { name: '보내기' })).toBeEnabled();
  });
});

describe('박스 스캔 — 보내기와 멱등 (decisions/0020, 어드민 ScanPage와 같은 규칙)', () => {
  it('발주분 입고: 열린 발주(ORDERED·RECEIVING)를 고르고 처음 보낼 때 scanId를 만든다. 결과는 줄마다, 보낸 박스는 고칠 수 없고, 현장 조회를 모두 다시 읽는다', async () => {
    const { calls } = mockApi({ ...orders, 'POST /scans': (c) => ({ status: 201, body: result(bodyOf(c), false) }) });
    loginAs();
    const { client } = renderPage(<ScanPage />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await screen.findByRole('option', { name: /SE0003/ });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['발주 선택', 'SE0004 SN-200 10대', 'SE0003 SN-100 50대']);
    expect(calls.filter((c) => c.path === '/purchase-orders').map((c) => c.query.get('status'))).toEqual(['ORDERED', 'RECEIVING']);
    await userEvent.selectOptions(screen.getByLabelText('발주'), 'SE0003');
    await userEvent.click(screen.getByLabelText(/시리얼/));
    await scanBarcode('SN-0001');
    await scanBarcode('SN-0002');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));

    expect(await screen.findByRole('status')).toHaveTextContent('발주 SE0003 입고: 성공 1 · 거절 1');
    expect(rows().map((r) => r.textContent)).toEqual(['SN-0001입고됨', 'SN-0002납품 명세에 없음납품 명세에 없는 시리얼입니다.']);
    const body = bodyOf(posts(calls)[0]);
    expect(body).toEqual({ scanId: expect.stringMatching(/^BOX-[0-9a-f-]{36}$/), kind: 'RECEIVE', poNo: 'SE0003', serials: ['SN-0001', 'SN-0002'] });
    expect(screen.getByLabelText('scanId')).toHaveTextContent(body.scanId);
    expect(screen.getByLabelText(/시리얼/)).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: /빼기/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '회수 입고' })).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/시리얼/));
    await scanBarcode('SN-0003'); // 보낸 뒤 스캐너가 또 찍어도 목록이 바뀌지 않는다
    expect(rows()).toHaveLength(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.all });
  });

  it('회수 입고는 발주 없이 보낸다(poNo를 보내면 서버가 400 PO_NOT_ALLOWED)', async () => {
    const { calls } = mockApi({ ...orders, 'POST /scans': (c) => ({ status: 201, body: result(bodyOf(c), false) }) });
    loginAs();
    renderPage(<ScanPage />);
    await userEvent.click(screen.getByRole('button', { name: '회수 입고' }));
    expect(screen.queryByLabelText('발주')).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/시리얼/));
    await scanBarcode('RT-0001');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(await screen.findByText('회수 입고됨')).toBeInTheDocument();
    expect(bodyOf(posts(calls)[0])).toEqual({ scanId: expect.any(String), kind: 'RETURN_IN', serials: ['RT-0001'] });
  });

  it.each([
    ['처리 중 409', { status: 409, body: { statusCode: 409, code: 'SCAN_IN_PROGRESS', message: '처리 중' } }],
    ['5xx', { status: 503, body: { statusCode: 503, message: '잠시 뒤' } }],
    ['박스 되돌림 409', { status: 409, body: { statusCode: 409, code: 'VERSION_CONFLICT', message: '겹침' } }],
  ])('응답을 못 받으면(%s) 같은 scanId로 다시 보낸다 — 두 번째는 저장된 결과(replayed)', async (_name, first) => {
    let n = 0;
    const { calls } = mockApi({
      ...orders,
      'POST /scans': (c) => (++n === 1 ? first : { status: 200, body: result(bodyOf(c), true) }),
    });
    loginAs();
    renderPage(<ScanPage />);
    await userEvent.click(screen.getByRole('button', { name: '회수 입고' }));
    await userEvent.click(screen.getByLabelText(/시리얼/));
    await scanBarcode('RT-0001');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText(/시리얼/)).toHaveAttribute('readonly'); // 다시 보낼 박스는 그대로 잠겨 있다
    await userEvent.click(screen.getByRole('button', { name: '같은 박스 다시 보내기' }));
    expect(await screen.findByRole('status')).toHaveTextContent('이미 처리된 박스 — 저장된 결과입니다.');
    const [a, b] = posts(calls).map(bodyOf);
    expect(b).toEqual(a); // scanId·내용 모두 같다
  });

  it('입력 오류(4xx)면 scanId를 버린다 — 박스를 고칠 수 있고, 고친 뒤 보내면 새 scanId', async () => {
    let n = 0;
    const { calls } = mockApi({
      ...orders,
      'POST /scans': (c) =>
        ++n === 1 ? { status: 422, body: { statusCode: 422, code: 'PO_CLOSED', message: '마감된 발주' } } : { status: 201, body: result(bodyOf(c), false) },
    });
    loginAs();
    renderPage(<ScanPage />);
    await screen.findByRole('option', { name: /SE0003/ });
    await userEvent.selectOptions(screen.getByLabelText('발주'), 'SE0003');
    await userEvent.click(screen.getByLabelText(/시리얼/));
    await scanBarcode('SN-0001');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('마감된 발주입니다. 다른 발주를 고르세요.');
    expect(screen.queryByLabelText('scanId')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/시리얼/)).not.toHaveAttribute('readonly');
    await userEvent.selectOptions(screen.getByLabelText('발주'), 'SE0004');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await screen.findByRole('status');
    const [a, b] = posts(calls).map(bodyOf);
    expect(b.scanId).not.toBe(a.scanId);
    expect(b.poNo).toBe('SE0004');
  });

  it('결과를 못 받은 박스를 버릴 때는 확인을 받는다. 결과를 받은 뒤 새 박스는 확인 없이 비우고 다음 박스는 새 scanId', async () => {
    let n = 0;
    const { calls } = mockApi({
      ...orders,
      'POST /scans': (c) => (++n === 1 ? { status: 503, body: { statusCode: 503, message: '잠시 뒤' } } : { status: 201, body: result(bodyOf(c), false) }),
    });
    const confirm = vi.spyOn(window, 'confirm');
    loginAs();
    renderPage(<ScanPage />);
    await userEvent.click(screen.getByRole('button', { name: '회수 입고' }));
    await userEvent.click(screen.getByLabelText(/시리얼/));
    await scanBarcode('RT-0001');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await screen.findByRole('alert');
    const first = bodyOf(posts(calls)[0]).scanId;

    confirm.mockReturnValueOnce(false);
    await userEvent.click(screen.getByRole('button', { name: '새 박스' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('결과를 받지 못한 박스입니다'));
    expect(screen.getByLabelText('scanId')).toHaveTextContent(first); // 취소하면 그대로

    confirm.mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: '새 박스' }));
    expect(screen.queryByLabelText('scanId')).not.toBeInTheDocument();
    expect(rows()).toHaveLength(0);
    expect(screen.getByLabelText(/시리얼/)).toHaveFocus(); // 새 박스 → 바로 스캔

    await scanBarcode('RT-0002');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await screen.findByRole('status');
    confirm.mockClear();
    await userEvent.click(screen.getByRole('button', { name: '새 박스' }));
    expect(confirm).not.toHaveBeenCalled();
    await scanBarcode('RT-0003');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(posts(calls)).toHaveLength(3));
    const ids = posts(calls).map((c) => bodyOf(c).scanId);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('박스 스캔 — 초점과 잠긴 박스 안내 (Task 3 리뷰 반영, decisions/0064 보탬)', () => {
  it('스캔 종류나 발주를 고르면 초점이 시리얼 입력칸으로 돌아온다 — 스캐너 글자가 발주 select를 바꾸지 못한다', async () => {
    mockApi(orders);
    loginAs();
    renderPage(<ScanPage />);
    const field = screen.getByLabelText(/시리얼/);
    await userEvent.click(screen.getByRole('button', { name: '회수 입고' }));
    expect(field).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: '발주분 입고' }));
    expect(field).toHaveFocus();
    await screen.findByRole('option', { name: /SE0003/ });
    await userEvent.selectOptions(screen.getByLabelText('발주'), 'SE0003');
    expect(field).toHaveFocus();
    await scanBarcode('SE0004'); // 클릭 없이 바로 스캐너 — 글자가 select로 가면 type-ahead로 SE0004가 골라진다
    expect(rows().map((r) => r.querySelector('.serial')?.textContent)).toEqual(['SE0004']);
    expect(screen.getByLabelText('발주')).toHaveValue('SE0003');
  });

  it('결과가 오면 "새 박스"에 초점과 안내. 잠긴 입력칸에 스캐너가 찍어도(Enter) 같은 안내이고 목록은 그대로', async () => {
    mockApi({ ...orders, 'POST /scans': (c) => ({ status: 201, body: result(bodyOf(c), false) }) });
    loginAs();
    renderPage(<ScanPage />);
    await userEvent.click(screen.getByRole('button', { name: '회수 입고' }));
    await scanBarcode('RT-0001');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await screen.findByRole('status');
    expect(screen.getByRole('button', { name: '새 박스' })).toHaveFocus();
    expect(screen.getByRole('note')).toHaveTextContent('새 박스를 눌러야 다음을 찍을 수 있습니다');
    await userEvent.click(screen.getByRole('button', { name: '새 박스' }));
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/시리얼/)).toHaveFocus();
  });

  it('결과 없이 잠긴 박스(보내다 실패)에 스캐너가 찍으면 안내가 뜨고, 같은 박스 다시 보내기는 눌리지 않는다', async () => {
    const { calls } = mockApi({ ...orders, 'POST /scans': () => ({ status: 503, body: { statusCode: 503, message: '잠시 뒤' } }) });
    loginAs();
    renderPage(<ScanPage />);
    await userEvent.click(screen.getByRole('button', { name: '회수 입고' }));
    await scanBarcode('RT-0001');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/시리얼/));
    await scanBarcode('RT-0002');
    expect(screen.getByRole('note')).toHaveTextContent('새 박스를 눌러야 다음을 찍을 수 있습니다');
    expect(rows()).toHaveLength(1);
    expect(posts(calls)).toHaveLength(1);
  });

  it('고른 발주가 다시 읽은 열린 발주에서 빠지면(마감) 다음 박스에서 발주 선택으로 돌아간다', async () => {
    let open = [...orderRows];
    mockApi({
      'GET /purchase-orders': (c: Call) => ({ body: { items: open.filter((p) => p.status === c.query.get('status')), nextBeforeId: null } }),
      'POST /scans': (c) => {
        open = open.filter((p) => p.poNo !== 'SE0003'); // 이 박스로 발주가 다 들어와 마감
        return { status: 201, body: result(bodyOf(c), false) };
      },
    });
    loginAs();
    renderPage(<ScanPage />);
    await screen.findByRole('option', { name: /SE0003/ });
    await userEvent.selectOptions(screen.getByLabelText('발주'), 'SE0003');
    await scanBarcode('SN-0001');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await screen.findByRole('status');
    await userEvent.click(screen.getByRole('button', { name: '새 박스' }));
    await waitFor(() => expect(screen.getByLabelText('발주')).toHaveValue(''));
  });

  it('열린 발주가 100개를 넘어 잘렸으면(nextBeforeId) 알린다', async () => {
    mockApi({ 'GET /purchase-orders': (c: Call) => ({ body: { items: c.query.get('status') === 'ORDERED' ? [orderRows[1]] : [], nextBeforeId: c.query.get('status') === 'ORDERED' ? 4 : null } }) });
    loginAs();
    renderPage(<ScanPage />);
    expect(await screen.findByText('열린 발주가 많아 최근 발주만 보입니다(상태별 최근 100개). 없는 발주는 어드민에서 확인하세요.')).toBeInTheDocument();
  });

  it('붙여 넣기는 입력칸의 커서 자리에 들어간다(앞뒤 글자를 잃지 않는다)', async () => {
    mockApi(orders);
    loginAs();
    renderPage(<ScanPage />);
    const field = screen.getByLabelText(/시리얼/) as HTMLInputElement;
    await userEvent.type(field, 'SN-AAAASN-BBBB');
    field.setSelectionRange(7, 7);
    await userEvent.paste(' SN-1111 SN-2222 ');
    expect(rows().map((r) => r.querySelector('.serial')?.textContent)).toEqual(['SN-AAAA', 'SN-1111', 'SN-2222', 'SN-BBBB']);
  });
});
