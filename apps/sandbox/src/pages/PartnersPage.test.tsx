import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { partnersApi, partnersConfig, request } from '../test/fixtures';
import { mockServers, renderApp } from '../test/render';

describe('가상 업체 화면 (보강 8)', () => {
  it('업체 다섯 카드와 지금 값(서버에서 읽음), 켜진 장애는 머리에 표시', async () => {
    mockServers(partnersApi(partnersConfig({ bungae: { force429Rate: 0.3 } })));
    renderApp('/partners');
    const bungae = await screen.findByRole('region', { name: '번개택배' });
    expect(within(bungae).getByLabelText('429 확률(%)')).toHaveValue(30);
    expect(within(bungae).getByText('장애: 429 확률')).toBeInTheDocument();
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['번개택배', '느림보물류', '세움전자', '브릿지VAN', '톡톡메신저', '최근 요청', '톡톡 메시지']);
    expect(within(screen.getByRole('region', { name: '느림보물류' })).getByText('정상')).toBeInTheDocument();
  });

  it('값을 바꿔 적용하면 그 업체의 바뀐 손잡이만 보낸다', async () => {
    const { calls } = mockServers({ ...partnersApi(), 'POST /partners/__admin/config': () => ({ body: partnersConfig({ bungae: { force429Rate: 0.5, delayMs: 800 } }) }) });
    renderApp('/partners');
    const bungae = await screen.findByRole('region', { name: '번개택배' });
    await userEvent.clear(within(bungae).getByLabelText('429 확률(%)'));
    await userEvent.type(within(bungae).getByLabelText('429 확률(%)'), '50');
    await userEvent.clear(within(bungae).getByLabelText('추적 응답 지연(ms)'));
    await userEvent.type(within(bungae).getByLabelText('추적 응답 지연(ms)'), '800');
    await userEvent.click(within(bungae).getByRole('button', { name: '적용' }));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ bungae: { force429Rate: 0.5, delayMs: 800 } });
    // 적용하면 서버가 돌려준 값으로 카드를 새로 그린다 — 카드를 다시 찾는다
    expect(await screen.findByText('장애: 429 확률 · 추적 응답 지연')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '번개택배' })).getByLabelText('429 확률(%)')).toHaveValue(50);
  });

  it('범위 밖 값(101%)이면 적용 단추가 꺼진다. 참거짓 손잡이는 체크 상자', async () => {
    mockServers(partnersApi());
    renderApp('/partners');
    const bungae = await screen.findByRole('region', { name: '번개택배' });
    await userEvent.clear(within(bungae).getByLabelText('429 확률(%)'));
    await userEvent.type(within(bungae).getByLabelText('429 확률(%)'), '101');
    expect(within(bungae).getByRole('button', { name: '적용' })).toBeDisabled();
    expect(within(screen.getByRole('region', { name: '느림보물류' })).getByRole('checkbox', { name: '이벤트 순서 섞기' })).not.toBeChecked();
  });

  it('모두 기본값으로: 데이터도 지운다는 확인을 받고 POST /__admin/reset', async () => {
    const { calls } = mockServers({ ...partnersApi(), 'POST /partners/__admin/reset': () => ({ body: partnersConfig() }) });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderApp('/partners');
    await screen.findByRole('region', { name: '번개택배' });
    await userEvent.click(screen.getByRole('button', { name: '모두 기본값으로' }));
    expect(calls.some((c) => c.path === '/partners/__admin/reset')).toBe(false);
    expect(confirm.mock.calls[0][0]).toContain('운송장');
    await userEvent.click(screen.getByRole('button', { name: '모두 기본값으로' }));
    expect(calls.find((c) => c.method === 'POST')?.path).toBe('/partners/__admin/reset');
  });

  it('최근 요청: 시각·업체 이름·요청·상태(색)·시간, 업체로 거르기', async () => {
    mockServers(partnersApi(partnersConfig(), [request({ id: 3, status: 429 }), request({ id: 2, partner: 'neurimbo', path: '/neurimbo/api/track?invoiceNo=X1', status: 503 }), request({ id: 1 })]));
    renderApp('/partners');
    const table = await screen.findByRole('table', { name: '최근 요청' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('번개택배');
    expect(within(rows[0]).getByText('429')).toHaveClass('code-4xx');
    expect(within(rows[1]).getByText('503')).toHaveClass('code-5xx');
    expect(rows[1]).toHaveTextContent('/neurimbo/api/track?invoiceNo=X1');
    await userEvent.selectOptions(screen.getByLabelText('업체'), 'neurimbo');
    expect(within(screen.getByRole('table', { name: '최근 요청' })).getAllByRole('row').slice(1)).toHaveLength(1);
  });

  it('가상 업체 서버가 안 떠 있으면 띄우는 명령을 안내한다', async () => {
    mockServers({ 'GET /partners/__admin/config': () => 'down', 'GET /partners/__admin/requests': () => 'down', 'GET /partners/__admin/toktok/messages': () => 'down' });
    renderApp('/partners');
    const alert = (await screen.findAllByRole('alert'))[0];
    expect(alert).toHaveTextContent('가상 업체 서버(:4010)에 연결하지 못했습니다');
    expect(alert).toHaveTextContent('cd apps/partners && npm run build && npm start');
  });
});
