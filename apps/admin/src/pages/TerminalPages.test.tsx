import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, useNavigate } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { TerminalDetail, TerminalStatus, TerminalView, TransitionTarget } from '@terminal-ops/contracts';
import { loginAs, mockApi, renderPage } from '../test/render';
import { TerminalDetailPage } from './TerminalDetailPage';
import { TerminalListPage } from './TerminalListPage';

const row = (serialNo: string, status: TerminalStatus = 'IN_STOCK'): TerminalView => ({
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

function BackButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(-1)}>
      뒤로
    </button>
  );
}

describe('단말기 목록 — Task 5 리뷰 반영', () => {
  const listApi = () =>
    mockApi({
      ...reference,
      'GET /terminals': (c) => ({
        body: { items: Number(c.query.get('page')) > 3 ? [] : [row(`T-${c.query.get('page')}`)], total: 45, page: Number(c.query.get('page')), size: 20 },
      }),
    });

  it('검색한 뒤 뒤로 가면 입력칸(draft)도 주소의 조건으로 돌아온다', async () => {
    listApi();
    renderPage(
      <>
        <TerminalListPage />
        <BackButton />
      </>,
      { route: '/terminals', path: '/terminals' },
    );
    await screen.findByRole('link', { name: 'T-1' });
    await userEvent.selectOptions(screen.getByLabelText('상태'), 'IN_SERVICE');
    await userEvent.type(screen.getByLabelText('시리얼 앞부분'), 'AS-');
    await userEvent.click(screen.getByRole('button', { name: '검색' }));
    await waitFor(() => expect(screen.getByLabelText('시리얼 앞부분')).toHaveValue('AS-'));
    await userEvent.click(screen.getByRole('button', { name: '뒤로' }));
    await waitFor(() => expect(screen.getByLabelText('시리얼 앞부분')).toHaveValue(''));
    expect(screen.getByLabelText('상태')).toHaveValue('');
  });

  it('page가 소수면 정수로 맞춰 부른다', async () => {
    const { calls } = listApi();
    renderPage(<TerminalListPage />, { route: '/terminals?page=2.7', path: '/terminals' });
    await screen.findByRole('link', { name: 'T-2' });
    expect(calls.filter((c) => c.path === '/terminals').map((c) => c.query.get('page'))).toEqual(['2']);
  });

  it('마지막 쪽을 넘긴 page면 마지막 쪽으로 옮긴다', async () => {
    listApi();
    renderPage(<TerminalListPage />, { route: '/terminals?page=99', path: '/terminals' });
    expect(await screen.findByRole('link', { name: 'T-3' })).toBeInTheDocument();
    expect(screen.getByText('3 / 3쪽')).toBeInTheDocument();
  });

  it('표 머리글에 scope=col이 있다', async () => {
    listApi();
    renderPage(<TerminalListPage />, { route: '/terminals', path: '/terminals' });
    await screen.findByRole('link', { name: 'T-1' });
    for (const th of screen.getAllByRole('columnheader')) expect(th).toHaveAttribute('scope', 'col');
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

  it('기본 정보와 타임라인(최근 것부터), 서버가 준 전이만 버튼으로. 로그인 정보가 없으면 바꾸기가 꺼진다', async () => {
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
    expect(post.headers['X-Operator']).toBeUndefined(); // 작업자는 서버가 세션에서 정한다(보강 2)
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

  describe('Task 5 리뷰 반영', () => {
    const inspectable = (version = 1) =>
      detail({ status: 'IN_STOCK', version, allowedTransitions: [], actions: { allocate: false, cancelAllocation: false, ship: false, inspect: true } });

    it('로딩 중이면 불러오는 중을 보여 준다', async () => {
      mockApi(common(() => detail()));
      open();
      expect(screen.getByText('불러오는 중')).toBeInTheDocument();
      await screen.findByText('강남김밥 (GANGNAM-KIMBAP)');
      expect(screen.queryByText('불러오는 중')).not.toBeInTheDocument();
    });

    it('검수를 저장하면 단말기 목록 캐시도 무효화한다', async () => {
      mockApi({
        ...common(() => inspectable()),
        'GET /inspection-items': () => ({ body: [{ code: 'POWER', label: '전원', sortOrder: 0 }] }),
        'POST /terminals/AS-1/inspections': () => ({ status: 201, body: {} }),
      });
      loginAs();
      const { client } = open();
      client.setQueryData(['terminals', 'probe'], { items: [] });
      await userEvent.click(await screen.findByRole('button', { name: '검수 결과 저장' }));
      await waitFor(() => expect(client.getQueryState(['terminals', 'probe'])?.isInvalidated).toBe(true));
    });

    it('검수 항목을 못 읽으면 오류를 보여 준다', async () => {
      mockApi({
        ...common(() => inspectable()),
        'GET /inspection-items': () => ({ status: 500, body: { statusCode: 500, message: '검수 항목 읽기 실패' } }),
      });
      open();
      expect(await screen.findByRole('alert')).toHaveTextContent('검수 항목 읽기 실패');
    });

    it('검수 저장이 409면 "다시 불러오기"가 상세를 다시 읽는다', async () => {
      let reads = 0;
      mockApi({
        ...common(() => {
          reads += 1;
          return inspectable(reads);
        }),
        'GET /inspection-items': () => ({ body: [{ code: 'POWER', label: '전원', sortOrder: 0 }] }),
        'POST /terminals/AS-1/inspections': () => ({ status: 409, body: { statusCode: 409, code: 'VERSION_CONFLICT', message: '충돌' } }),
      });
      loginAs();
      open();
      await userEvent.click(await screen.findByRole('button', { name: '검수 결과 저장' }));
      const alert = await screen.findByRole('alert');
      const before = reads;
      await userEvent.click(within(alert).getByRole('button', { name: '다시 불러오기' }));
      await waitFor(() => expect(reads).toBeGreaterThan(before));
    });

    it('409 뒤 다시 불러와 재시도하면 새 version(expectedVersion)을 보낸다', async () => {
      let reads = 0;
      let posts = 0;
      const { calls } = mockApi({
        ...common(() => {
          reads += 1;
          return detail({ version: reads });
        }),
        'POST /terminals/AS-1/transitions': () =>
          ++posts === 1 ? { status: 409, body: { statusCode: 409, code: 'VERSION_CONFLICT', message: '충돌' } } : { body: {} },
      });
      loginAs();
      open();
      await userEvent.click(await screen.findByRole('button', { name: '→ 배송 완료' }));
      await userEvent.type(screen.getByLabelText('변경 사유'), '현장 확인');
      await userEvent.click(screen.getByRole('button', { name: '배송 완료(으)로 바꾸기' }));
      await userEvent.click(within(await screen.findByRole('alert')).getByRole('button', { name: '다시 불러오기' }));
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
      await userEvent.click(screen.getByRole('button', { name: '배송 완료(으)로 바꾸기' }));
      await waitFor(() => expect(posts).toBe(2));
      const sent = calls.filter((c) => c.method === 'POST').map((c) => (c.body as { expectedVersion: number }).expectedVersion);
      expect(sent[0]).toBe(1);
      expect(sent[1]).toBeGreaterThan(1);
    });

    it('다시 불러온 상세에서 고른 전이가 사라졌으면 선택을 풀고, 상세 전체(타임라인 포함)를 다시 읽는다', async () => {
      let transitions: TransitionTarget[] = [{ to: 'DELIVERED', blockedReason: null }];
      const { calls } = mockApi(common(() => detail({ allowedTransitions: transitions })));
      open();
      await userEvent.click(await screen.findByRole('button', { name: '→ 배송 완료' }));
      expect(screen.getByLabelText('변경 사유')).toBeInTheDocument();
      transitions = [{ to: 'IN_SERVICE', blockedReason: null }];
      const historyBefore = calls.filter((c) => c.path === '/terminals/AS-1/history').length;
      await userEvent.click(screen.getByRole('button', { name: '다시 불러오기' }));
      await screen.findByRole('button', { name: '→ 운영 중' });
      expect(screen.queryByLabelText('변경 사유')).not.toBeInTheDocument();
      expect(calls.filter((c) => c.path === '/terminals/AS-1/history').length).toBeGreaterThan(historyBefore);
    });

    it('다른 단말기로 옮기면 입력하던 사유가 남지 않는다', async () => {
      mockApi({
        ...common(() => detail()),
        'GET /terminals/AS-2': () => ({ body: detail({ serialNo: 'AS-2' }) }),
        'GET /terminals/AS-2/history': () => ({ body: [] }),
        'GET /terminals/AS-2/connectivity': () => ({ body: { serialNo: 'AS-2', source: 'none', online: false, lastSeenAt: null, firmwareVersion: null } }),
        'GET /terminals/AS-2/inspections': () => ({ body: [] }),
      });
      renderPage(
        <>
          <TerminalDetailPage />
          <Link to="/terminals/AS-2">AS-2로</Link>
        </>,
        { route: '/terminals/AS-1', path: '/terminals/:serialNo' },
      );
      await userEvent.click(await screen.findByRole('button', { name: '→ 배송 완료' }));
      await userEvent.type(screen.getByLabelText('변경 사유'), '남으면 안 됨');
      await userEvent.click(screen.getByRole('link', { name: 'AS-2로' }));
      await screen.findByRole('heading', { name: '단말기 AS-2' });
      await screen.findByRole('button', { name: '→ 배송 완료' });
      expect(screen.queryByLabelText('변경 사유')).not.toBeInTheDocument();
    });
  });
});
