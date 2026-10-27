import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { loginAs, mockApi, renderPage, type Call } from '../test/render';
import { parseSerials, ScanPage } from './ScanPage';

const orders = {
  'GET /purchase-orders': () => ({
    body: {
      items: [
        { id: 3, poNo: 'SE0003', modelCode: 'SN-100', quantity: 50, status: 'RECEIVING' },
        { id: 2, poNo: 'SE0002', modelCode: 'SN-200', quantity: 10, status: 'CLOSED' },
      ],
      nextBeforeId: null,
    },
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

  it('작업자 이름이 없으면 보내기가 꺼진다', async () => {
    mockApi({});
    renderPage(<ScanPage />);
    await userEvent.click(screen.getByLabelText(/회수 입고/));
    await userEvent.type(screen.getByLabelText('시리얼'), 'RT-0001');
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();
  });
});
