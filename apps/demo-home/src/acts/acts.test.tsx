import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetProgress } from '../lib/progress';
import { baseApi, rollout, syncRun, terminal, ticket } from '../test/fixtures';
import { loginAs, mockApi, OPERATOR, renderApp } from '../test/render';

const asOperator = (handlers: Record<string, () => unknown> = {}) => {
  const api = mockApi({ ...baseApi(), 'GET /auth/me': () => ({ body: OPERATOR }), ...handlers } as Parameters<typeof mockApi>[0]);
  loginAs();
  return api;
};
const step = (title: string) => screen.findByRole('region', { name: title });
afterEach(() => resetProgress());

describe('막 1 한눈에', () => {
  it('처음 화면 숫자: 운영 중·온라인·오프라인, 열린 이상, VAN 어긋남, 진행 중 배포, 열린 A/S', async () => {
    asOperator();
    renderApp('/act/1');
    const card = await step('처음 화면 숫자');
    expect(await within(card).findByText('운영 중 12 · 온라인 11 · 오프라인 1')).toBeInTheDocument();
    expect(card).toHaveTextContent('열린 이상2');
    expect(card).toHaveTextContent('VAN 어긋남4');
    expect(card).toHaveTextContent('진행 중 배포1');
    expect(within(card).getByRole('link', { name: '어드민 처음 화면 열기 ↗' })).toHaveAttribute('href', 'http://localhost:5173/');
  });
});

describe('막 2 공장에서 창고로', () => {
  it('열린 발주가 없으면 새 발주(10대) 단추, 있으면 납품 명세를 불러와 시리얼을 보인다', async () => {
    let orders: object[] = [];
    const { calls } = asOperator({
      'GET /purchase-orders': () => ({ body: { items: orders, truncated: false } }),
      'POST /purchase-orders': () => {
        orders = [{ poNo: 'SE-1', modelCode: 'SN-100', quantity: 10, status: 'ORDERED' }];
        return { status: 201, body: orders[0] };
      },
      'GET /partners/seum/v1/purchase-orders/:po/delivery-note': () => ({ body: { poNo: 'SE-1', modelCode: 'SN-100', quantity: 10, serials: ['SE-1-0001', 'SE-1-0002'] } }),
      'GET /purchase-orders/:po/reconciliation': () => ({ body: { poNo: 'SE-1', modelCode: 'SN-100', status: 'ORDERED', ordered: 10, noted: 8, received: 0, shortfall: 2, missing: [], unexpected: [] } }),
    });
    renderApp('/act/2');
    const note = await step('공장 납품 명세');
    await userEvent.click(await within(note).findByRole('button', { name: '실행: 새 발주(SN-100 10대)' }));
    expect(calls.find((c) => c.method === 'POST' && c.path === '/purchase-orders')?.body).toEqual({ modelCode: 'SN-100', quantity: 10 });
    await userEvent.click(await within(note).findByRole('button', { name: '실행: 납품 명세 불러오기' }));
    expect(await within(note).findByRole('textbox', { name: '납품 시리얼' })).toHaveValue('SE-1-0001\nSE-1-0002');
    const close = await step('입고 대조와 마감');
    expect(await within(close).findByText('발주 10 · 명세 8 · 입고 0 · 차이 2')).toBeInTheDocument();
  });

  it('마감 뒤 새 발주를 내면 그 새 발주로 넘어간다(마감한 발주에 머물지 않게 — 최종 검토). 새 발주는 2-1을 끝냄으로 표시하지 않는다', async () => {
    let orders = [{ poNo: 'SE-1', modelCode: 'SN-100', quantity: 10, status: 'RECEIVING' }];
    asOperator({
      'GET /purchase-orders': () => ({ body: { items: orders, truncated: false } }),
      'GET /purchase-orders/:po/reconciliation': () => ({ body: { poNo: 'SE-1', modelCode: 'SN-100', status: orders[orders.length - 1].status, ordered: 10, noted: 8, received: 8, shortfall: 2, missing: [], unexpected: [] } }),
      'POST /purchase-orders/:po/close': () => {
        orders = [{ ...orders[0], status: 'CLOSED' }];
        return { body: {} };
      },
      'POST /purchase-orders': () => {
        orders = [{ poNo: 'SE-2', modelCode: 'SN-100', quantity: 10, status: 'ORDERED' }, ...orders];
        return { status: 201, body: orders[0] };
      },
    } as never);
    renderApp('/act/2');
    await userEvent.click(await within(await step('입고 대조와 마감')).findByRole('button', { name: '실행: 발주 마감' }));
    const note = await step('공장 납품 명세');
    await userEvent.click(await within(note).findByRole('button', { name: '실행: 새 발주(SN-100 10대)' }));
    expect(await within(note).findByRole('button', { name: '실행: 납품 명세 불러오기' })).toBeInTheDocument();
    expect(within(note).getByText('SE-2')).toBeInTheDocument();
    expect(within(note).getByRole('checkbox', { name: '끝냄' })).not.toBeChecked();
  });

  it('마감하면 그 발주의 대조가 그대로 남는다(열린 발주가 없어져도 — 리허설에서 찾음)', async () => {
    let status = 'RECEIVING';
    asOperator({
      'GET /purchase-orders': () => ({ body: { items: [{ poNo: 'SE-1', modelCode: 'SN-100', quantity: 10, status }], truncated: false } }),
      'GET /purchase-orders/:po/reconciliation': () => ({ body: { poNo: 'SE-1', modelCode: 'SN-100', status, ordered: 10, noted: 8, received: 8, shortfall: 2, missing: [], unexpected: [] } }),
      'POST /purchase-orders/:po/close': () => {
        status = 'CLOSED';
        return { body: {} };
      },
    } as never);
    renderApp('/act/2');
    const close = await step('입고 대조와 마감');
    await userEvent.click(await within(close).findByRole('button', { name: '실행: 발주 마감' }));
    expect(await within(close).findByText('SE-1 · 마감됨')).toBeInTheDocument();
    expect(within(close).getByText('발주 10 · 명세 8 · 입고 8 · 차이 2')).toBeInTheDocument();
  });
});

describe('막 3 가맹점까지', () => {
  it('실행: 재고 → 강남김밥 배정 → 번개 출고, 끝냄 표시, 다음 단계가 그 단말기 상태를 읽는다', async () => {
    let status = 'IN_STOCK';
    const { calls } = asOperator({
      'GET /terminals': () => ({ body: { items: [terminal('DM-0014', 'IN_STOCK')], total: 1, page: 1, size: 50 } }),
      'GET /terminals/:s': () => ({ body: terminal('DM-0014', status as 'IN_STOCK', { merchantCode: 'GANGNAM-KIMBAP' }) }),
      'POST /terminals/:s/allocations': () => ({ status: 201, body: {} }),
      'POST /shipments': () => {
        status = 'SHIPPED';
        return { status: 201, body: { id: 9, trackingNo: 'BG17932' } };
      },
    });
    renderApp('/act/3');
    const ship = await step('배정하고 출고');
    await userEvent.click(within(ship).getByRole('button', { name: '실행: 재고 한 대를 강남김밥으로 출고' }));
    expect(await within(ship).findByText(/DM-0014 · 운송장 BG17932/)).toBeInTheDocument();
    expect(within(ship).getByRole('checkbox', { name: '끝냄' })).toBeChecked();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/terminals/DM-0014/allocations', '/shipments']);
    const track = await step('배송 완료 기다리기');
    expect(await within(track).findByText('DM-0014 · 배송 중(SHIPPED)')).toBeInTheDocument();
  });
});

describe('막 4 고장과 교체', () => {
  it('가장 최근 열린 접수를 원격 점검 → 교체 출고하고 결과를 보인다', async () => {
    let tickets = [ticket({ id: 1, serialNo: 'DM-0001' }), ticket({ id: 3 })];
    const { calls } = asOperator({
      'GET /service-tickets': () => ({ body: { items: tickets, nextBeforeId: null } }),
      'GET /service-tickets/:id': () => ({ body: tickets[1] }),
      'GET /terminals/:s': () => ({ body: terminal('DM-0004', 'IN_SERVICE') }),
      'POST /service-tickets/:id/remote-checks': () => ({ body: {} }),
      'GET /terminals': () => ({ body: { items: [terminal('DM-0015', 'IN_STOCK')], total: 1, page: 1, size: 50 } }),
      'POST /service-tickets/:id/replacements': () => {
        tickets = [ticket({ id: 1, serialNo: 'DM-0001' }), ticket({ id: 3, status: 'REPLACING', replacementSerialNo: 'DM-0015' })];
        return { body: tickets[1] };
      },
    });
    renderApp('/act/4');
    const replace = await step('원격 점검 → 교체 출고');
    await userEvent.click(await within(replace).findByRole('button', { name: '실행: A/S #3 원격 점검 → 교체 출고' }));
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/service-tickets/3/remote-checks', '/service-tickets/3/replacements']);
    expect(calls.find((c) => c.path === '/terminals' && c.query.get('status') === 'IN_STOCK')?.query.get('modelCode')).toBe('SN-100');
    expect(await within(replace).findByText('A/S #3 · 교체 진행 중 · 교체품 DM-0015')).toBeInTheDocument();
  });
});

describe('막 5 택배사가 429를 낸다', () => {
  it('켜기 → 출고 → 최근 요청에 429, 수집 기록에 ERROR와 다시 시도 OK → 되돌리기', async () => {
    let rate = 0;
    const { calls } = asOperator({
      'GET /partners/__admin/config': () => ({ body: { bungae: { force429Rate: rate } } }),
      'POST /partners/__admin/config': (c: { body: { bungae: { force429Rate: number } } }) => {
        rate = c.body.bungae.force429Rate;
        return { body: {} };
      },
      'GET /terminals': () => ({ body: { items: [terminal('DM-0015', 'IN_STOCK')], total: 1, page: 1, size: 50 } }),
      'GET /terminals/:s': () => ({ body: terminal('DM-0015', 'IN_STOCK') }),
      'POST /terminals/:s/allocations': () => ({ status: 201, body: {} }),
      'POST /shipments': () => ({ status: 201, body: { id: 10, trackingNo: 'BG2' } }),
      'GET /partners/__admin/requests': () => ({ body: { total: 3, items: [{ id: 3, at: '2026-10-30T00:00:02.000Z', partner: 'bungae', method: 'GET', path: '/bungae/v1/trackings/BG2', status: 429, ms: 1 }] } }),
      'GET /sync-runs': () => ({ body: { items: [syncRun({ id: 2, attempt: 2, trackingNo: 'BG2' }), syncRun({ id: 1, outcome: 'ERROR', trackingNo: 'BG2', detail: 'PartnerRateLimitedError: 429' })], nextBeforeId: null } }),
    } as never);
    renderApp('/act/5');
    await userEvent.click(within(await step('장애 켜기: 429 50%')).getByRole('button', { name: '실행: 번개택배 429 확률 50%' }));
    expect(await within(await step('장애 켜기: 429 50%')).findByText('지금 번개택배 429 확률: 50%')).toBeInTheDocument();
    await userEvent.click(within(await step('출고 하나 → 반응')).getByRole('button', { name: '실행: 재고 한 대를 번개택배로 출고' }));
    const reaction = await step('출고 하나 → 반응');
    expect(await within(reaction).findByText('429')).toHaveClass('code-4xx');
    expect(await within(reaction).findByText(/ERROR · 1번째/)).toBeInTheDocument();
    expect(within(reaction).getByText(/OK · 2번째/)).toBeInTheDocument();
    await userEvent.click(within(await step('되돌리기: 0%')).getByRole('button', { name: '실행: 번개택배 429 확률 0%' }));
    expect(calls.filter((c) => c.path === '/partners/__admin/config' && c.method === 'POST').map((c) => c.body)).toEqual([{ bungae: { force429Rate: 0.5 } }, { bungae: { force429Rate: 0 } }]);
  });
});

describe('막 6 펌웨어 배포와 자동 중단', () => {
  it('배포 실행 → 진행 표, 같은 모델 배포가 아직 돌면 409를 안내', async () => {
    const { calls } = asOperator({
      'GET /firmware': () => ({ body: { items: [{ modelCode: 'SN-100', version: '1.1.0' }], nextBeforeId: null } }),
      'POST /firmware': () => ({ status: 201, body: {} }),
      'POST /firmware-rollouts': () => ({ status: 409, body: { statusCode: 409, code: 'ROLLOUT_ALREADY_ACTIVE', message: '모델 SN-100에 진행 중인 펌웨어 배포가 있습니다.' } }),
      'GET /firmware-rollouts': () => ({ body: { items: [rollout({ status: 'ABORTED', endReason: '자동 중단: 1단계 실패율 50% (1/2) > 기준 20%' })], nextBeforeId: null } }),
    } as never);
    renderApp('/act/6');
    const abort = await step('다시 배포 → 자동 중단');
    expect(await within(abort).findByText('SN-100 1.2.0 · 중단')).toBeInTheDocument();
    expect(within(abort).getByText('자동 중단: 1단계 실패율 50% (1/2) > 기준 20%')).toBeInTheDocument();
    await userEvent.click(within(abort).getByRole('button', { name: '실행: SN-100 새 버전 배포' }));
    expect(await within(abort).findByRole('alert')).toHaveTextContent('진행 중인 배포가 끝나면');
    expect(calls.find((c) => c.method === 'POST' && c.path === '/firmware')?.body).toEqual({ modelCode: 'SN-100', version: '1.2.0' });
  });
});

describe('막 7 단말기가 끊긴다', () => {
  it('끄기는 offlineSerials에 더하고, 기다리기는 접속 상태와 톡톡 알림을 읽는다', async () => {
    vi.spyOn(Date, 'now');
    const { calls } = asOperator({
      'POST /sim/__admin/config': () => ({ body: {} }),
      'GET /terminals/:s/connectivity': () => ({ body: { serialNo: 'DM-0005', source: 'redis', online: false, lastSeenAt: '2026-10-30T00:00:00.000Z', firmwareVersion: '1.0.0' } }),
      'GET /partners/__admin/toktok/messages': () => ({ body: { total: 1, messages: [{ channel: 'ops', idempotencyKey: 'k', text: '[단말온] DM-0005: 오프라인 (마지막 하트비트 …)', receivedAt: '2026-10-30T00:01:30.000Z', attachments: [] }] } }),
    } as never);
    renderApp('/act/7');
    await userEvent.click(within(await step('단말기 끄기')).getByRole('button', { name: '실행: DM-0005 끄기' }));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ offlineSerials: ['DM-0002', 'DM-0021', 'DM-0005'] });
    const wait = await step('오프라인 판정과 알림');
    expect(await within(wait).findByText('DM-0005 · 오프라인')).toBeInTheDocument();
    expect(within(wait).getByText('[단말온] DM-0005: 오프라인 (마지막 하트비트 …)')).toBeInTheDocument();
  });
});
