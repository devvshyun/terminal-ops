import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { TerminalDetail } from '../api/types';
import { loginAs, mockApi, renderPage } from '../test/render';
import { TerminalDetailPage } from './TerminalDetailPage';
import { TerminalListPage } from './TerminalListPage';

const row = (serialNo: string, status = 'IN_STOCK') => ({
  serialNo,
  modelCode: 'SN-100',
  merchantCode: null,
  status,
  statusChangedAt: '2026-10-26T01:00:00.000Z',
  version: 1,
  createdAt: '2026-10-26T01:00:00.000Z',
  updatedAt: '2026-10-26T01:00:00.000Z',
});

const reference = {
  'GET /terminal-models': () => ({ body: [{ code: 'SN-100', name: '유선 카운터형', requiresReinspection: false }] }),
  'GET /merchants': () => ({ body: [{ code: 'GANGNAM-KIMBAP', name: '강남김밥', address: '서울' }] }),
};

describe('단말기 목록 (F1)', () => {
  it('조건으로 검색하면 1쪽부터 다시 부르고, 다음 쪽은 page=2', async () => {
    const { calls } = mockApi({
      ...reference,
      'GET /terminals': (c) => ({ body: { items: [row(`T-${c.query.get('page')}`)], total: 45, page: Number(c.query.get('page')), size: 20 } }),
    });
    renderPage(<TerminalListPage />, { route: '/terminals', path: '/terminals' });
    expect(await screen.findByRole('link', { name: 'T-1' })).toHaveAttribute('href', '/terminals/T-1');
    expect(screen.getByText('총 45대')).toBeInTheDocument();
    expect(screen.getByText('1 / 3쪽')).toBeInTheDocument();
    expect(screen.getByText('2026-10-26 10:00:00 KST')).toBeInTheDocument(); // UTC → KST

    await userEvent.click(screen.getByRole('button', { name: '다음' }));
    expect(await screen.findByRole('link', { name: 'T-2' })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('상태'), 'IN_SERVICE');
    await userEvent.type(screen.getByLabelText('시리얼 앞부분'), 'AS-');
    await userEvent.click(screen.getByRole('button', { name: '검색' }));
    await waitFor(() => expect(calls.at(-1)!.query.get('status')).toBe('IN_SERVICE'));
    const last = calls.filter((c) => c.path === '/terminals').at(-1)!;
    expect([last.query.get('q'), last.query.get('page'), last.query.get('size')]).toEqual(['AS-', '1', '20']);
  });
});

describe('단말기 상세 (F2, decisions/0040)', () => {
  const detail = (over: Partial<TerminalDetail> = {}): TerminalDetail => ({
    ...row('AS-1', 'SHIPPED'),
    merchantCode: 'GANGNAM-KIMBAP',
    modelName: '유선 카운터형',
    merchantName: '강남김밥',
    allowedTransitions: [{ to: 'DELIVERED', blockedReason: null }],
    actions: { allocate: false, cancelAllocation: false, ship: false, inspect: false },
    ...over,
  });
  const common = (getDetail: () => TerminalDetail) => ({
    ...reference,
    'GET /terminals/AS-1': () => ({ body: getDetail() }),
    'GET /terminals/AS-1/history': () => ({
      body: [
        { fromStatus: null, toStatus: 'RECEIVED', source: 'SCAN', actor: 'kim', reason: '박스 입고', occurredAt: '2026-10-20T00:00:00.000Z' },
        { fromStatus: 'ALLOCATED', toStatus: 'SHIPPED', source: 'SHIPMENT', actor: 'lee', reason: '출고', occurredAt: '2026-10-25T00:00:00.000Z' },
      ],
    }),
    'GET /terminals/AS-1/connectivity': () => ({ body: { serialNo: 'AS-1', source: 'none', online: false, lastSeenAt: null, firmwareVersion: null } }),
    'GET /terminals/AS-1/inspections': () => ({ body: [] }),
  });
  const open = () => renderPage(<TerminalDetailPage />, { route: '/terminals/AS-1', path: '/terminals/:serialNo' });

  it('기본 정보와 타임라인(최근 것부터), 서버가 준 전이만 버튼으로. 작업자 이름이 없으면 바꾸기가 꺼진다', async () => {
    mockApi(common(() => detail({ allowedTransitions: [{ to: 'DELIVERED', blockedReason: null }, { to: 'IN_STOCK', blockedReason: '재검수 필수' }] })));
    open();
    expect(await screen.findByText('강남김밥 (GANGNAM-KIMBAP)')).toBeInTheDocument();
    const items = within(await screen.findByRole('list', { name: '상태 타임라인' })).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([expect.stringContaining('배정 → 출고(배송 중)'), expect.stringContaining('신규 → 입고')]);
    expect(screen.getByRole('button', { name: '→ 배송 완료' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '→ 재고' })).toBeDisabled(); // 모델 정책에 막힘
    expect(screen.getByText('재고: 재검수 필수')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '가맹점 배정' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '→ 배송 완료' }));
    await userEvent.type(screen.getByLabelText('변경 사유'), '현장 확인');
    expect(screen.getByRole('button', { name: '배송 완료(으)로 바꾸기' })).toBeDisabled();
  });

  it('전이: 사유와 화면에서 본 version을 보내고, 성공하면 다시 불러온다', async () => {
    let current = detail();
    const { calls } = mockApi({
      ...common(() => current),
      'POST /terminals/AS-1/transitions': () => {
        current = detail({ status: 'DELIVERED', version: 2, allowedTransitions: [{ to: 'IN_SERVICE', blockedReason: null }] });
        return { body: current };
      },
    });
    loginAs('김운영');
    open();
    await userEvent.click(await screen.findByRole('button', { name: '→ 배송 완료' }));
    await userEvent.type(screen.getByLabelText('변경 사유'), '현장 확인');
    await userEvent.click(screen.getByRole('button', { name: '배송 완료(으)로 바꾸기' }));
    expect(await screen.findByRole('button', { name: '→ 운영 중' })).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ to: 'DELIVERED', reason: '현장 확인', expectedVersion: 1 });
    expect(post.headers['X-Operator']).toBe(encodeURIComponent('김운영'));
  });

  it('409 VERSION_CONFLICT면 안내와 "다시 불러오기" — 누르면 상세를 다시 읽는다', async () => {
    let reads = 0;
    mockApi({
      ...common(() => {
        reads += 1;
        return detail({ version: reads });
      }),
      'POST /terminals/AS-1/transitions': () => ({ status: 409, body: { statusCode: 409, code: 'VERSION_CONFLICT', message: '다른 작업이 먼저 이 단말기를 변경했습니다.' } }),
    });
    loginAs();
    open();
    await userEvent.click(await screen.findByRole('button', { name: '→ 배송 완료' }));
    await userEvent.type(screen.getByLabelText('변경 사유'), '현장 확인');
    await userEvent.click(screen.getByRole('button', { name: '배송 완료(으)로 바꾸기' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('다른 작업이 먼저 이 단말기를 바꿨습니다');
    expect(alert).toHaveTextContent('VERSION_CONFLICT');
    const before = reads;
    await userEvent.click(within(alert).getByRole('button', { name: '다시 불러오기' }));
    await waitFor(() => expect(reads).toBe(before + 1));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('배정(actions.allocate): 가맹점을 골라 POST /allocations, 검수(actions.inspect): 불합격 표시한 항목만 passed false', async () => {
    const { calls } = mockApi({
      ...common(() => detail({ status: 'IN_STOCK', allowedTransitions: [], actions: { allocate: true, cancelAllocation: false, ship: false, inspect: true } })),
      'GET /inspection-items': () => ({ body: [{ code: 'POWER', label: '전원', sortOrder: 0 }, { code: 'PRINTER', label: '영수증 프린터', sortOrder: 1 }] }),
      'POST /terminals/AS-1/allocations': () => ({ status: 201, body: {} }),
      'POST /terminals/AS-1/inspections': () => ({ status: 201, body: {} }),
    });
    loginAs();
    open();
    await screen.findByRole('option', { name: '강남김밥 (GANGNAM-KIMBAP)' }); // 가맹점 목록이 온 뒤에 고른다
    await userEvent.selectOptions(screen.getByLabelText('배정 가맹점'), 'GANGNAM-KIMBAP');
    await userEvent.click(screen.getByRole('button', { name: '가맹점 배정' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/terminals/AS-1/allocations')).toBe(true));
    expect(calls.find((c) => c.path === '/terminals/AS-1/allocations')!.body).toEqual({ merchantCode: 'GANGNAM-KIMBAP', expectedVersion: 1 });

    await userEvent.click(await screen.findByLabelText('영수증 프린터 불합격'));
    await userEvent.click(screen.getByRole('button', { name: '검수 결과 저장' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/terminals/AS-1/inspections' && c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.path === '/terminals/AS-1/inspections' && c.method === 'POST')!.body).toEqual({
      results: [
        { itemCode: 'POWER', passed: true },
        { itemCode: 'PRINTER', passed: false },
      ],
    });
  });
});
