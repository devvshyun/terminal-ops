import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { simApi, simConfig, simDevices, simStats } from '../test/fixtures';
import { mockServers, renderApp } from '../test/render';

describe('단말기 시뮬레이터 화면 (보강 8)', () => {
  it('멈춰 있으면 시작 단추, 통계(보낸·받아들인·거절·실패·p95), 단말기 표(수 넷)', async () => {
    mockServers(simApi(simConfig(), simStats({ ticks: 4, heartbeatsSent: 12, heartbeatsAccepted: 9, heartbeatsRejected: 3, errors: 1, latency: { count: 4, p50: 8.2, p95: 21.7, max: 30 } })));
    renderApp('/devices');
    expect(await screen.findByRole('button', { name: '시작' })).toBeInTheDocument();
    const stats = await screen.findByRole('region', { name: '보낸 것' });
    expect(stats).toHaveTextContent('하트비트12');
    expect(stats).toHaveTextContent('받아들임9');
    expect(stats).toHaveTextContent('거절3');
    expect(stats).toHaveTextContent('실패한 요청1');
    expect(stats).toHaveTextContent('22ms');
    expect(await screen.findByText('전체 3 · 온라인 3 · 오프라인 0 · 업데이트 중 0')).toBeInTheDocument();
  });

  it('시작·정지는 POST /__admin/start·stop', async () => {
    let running = false;
    const { calls } = mockServers({
      ...simApi(),
      'GET /sim/__admin/stats': () => ({ body: simStats({ running }) }),
      'POST /sim/__admin/start': () => {
        running = true;
        return { body: { running: true } };
      },
      'POST /sim/__admin/stop': () => {
        running = false;
        return { body: { running: false } };
      },
    });
    renderApp('/devices');
    await userEvent.click(await screen.findByRole('button', { name: '시작' }));
    await userEvent.click(await screen.findByRole('button', { name: '정지' }));
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/sim/__admin/start', '/sim/__admin/stop']);
  });

  it('단말기 끄기·켜기는 offlineSerials를 바꿔 보낸다', async () => {
    const { calls } = mockServers({ ...simApi(simConfig({ offlineSerials: ['HB-0003'] })), 'POST /sim/__admin/config': () => ({ body: simConfig({ offlineSerials: ['HB-0003', 'HB-0001'] }) }) });
    renderApp('/devices');
    const table = await screen.findByRole('table', { name: '단말기' });
    const row = (serial: string) => within(table).getByRole('row', { name: new RegExp(serial) });
    expect(row('HB-0003')).toHaveTextContent('오프라인');
    await userEvent.click(within(row('HB-0001')).getByRole('button', { name: '끄기' }));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ offlineSerials: ['HB-0003', 'HB-0001'] });
    await userEvent.click(within(row('HB-0003')).getByRole('button', { name: '켜기' }));
    expect(calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({ offlineSerials: [] });
  });

  it('오프라인 비율(offlineRate)이 0보다 크면 꺼진 단말기는 하나씩 켤 수 없다 — offlineSerials에 있어도(두 쪽이 합쳐져 켜도 그대로라서)', async () => {
    mockServers(simApi(simConfig({ offlineRate: 0.5, offlineSerials: ['HB-0003'] }), simStats(), simDevices(['HB-0002', 'HB-0003'])));
    renderApp('/devices');
    const table = await screen.findByRole('table', { name: '단말기' });
    expect(within(within(table).getByRole('row', { name: /HB-0002/ })).getByRole('button', { name: '켜기' })).toBeDisabled();
    expect(within(within(table).getByRole('row', { name: /HB-0003/ })).getByRole('button', { name: '켜기' })).toBeDisabled();
    expect(within(within(table).getByRole('row', { name: /HB-0001/ })).getByRole('button', { name: '끄기' })).toBeEnabled();
  });

  it('끄기는 그때 서버의 offlineSerials를 다시 읽어 더한다(다른 곳에서 바뀐 것을 덮지 않게)', async () => {
    let reads = 0;
    const { calls } = mockServers({
      ...simApi(),
      'GET /sim/__admin/config': () => {
        reads += 1;
        return { body: simConfig({ offlineSerials: reads > 1 ? ['HB-0003'] : [] }) };
      },
      'POST /sim/__admin/config': () => ({ body: simConfig({ offlineSerials: ['HB-0003', 'HB-0001'] }) }),
    });
    renderApp('/devices');
    const table = await screen.findByRole('table', { name: '단말기' });
    await userEvent.click(within(within(table).getByRole('row', { name: /HB-0001/ })).getByRole('button', { name: '끄기' }));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ offlineSerials: ['HB-0003', 'HB-0001'] });
  });

  it('설정 폼에 적던 값은 단말기를 끄고 켜도 남는다', async () => {
    // 실제 서버처럼: POST가 바꾼 설정을 다음 GET이 돌려준다
    let current = simConfig();
    const { calls } = mockServers({
      ...simApi(),
      'GET /sim/__admin/config': () => ({ body: current }),
      'POST /sim/__admin/config': (c) => {
        current = { ...current, ...(c.body as object) };
        return { body: current };
      },
    });
    renderApp('/devices');
    const form = await screen.findByRole('form', { name: '시뮬레이터 설정' });
    await userEvent.clear(within(form).getByLabelText('주기(초)'));
    await userEvent.type(within(form).getByLabelText('주기(초)'), '7');
    await userEvent.click(within(screen.getByRole('table', { name: '단말기' })).getAllByRole('button', { name: '끄기' })[0]);
    // 끄기 응답(새 설정)이 캐시에 들어가고 설정을 다시 읽기까지 끝난 뒤(처음 · 끄기 직전 · 끄기 뒤 무효화 = 3번)
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.path === '/sim/__admin/config').length).toBeGreaterThanOrEqual(3));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(within(screen.getByRole('form', { name: '시뮬레이터 설정' })).getByLabelText('주기(초)')).toHaveValue(7);
  });

  it('숫자 칸을 비우면 0이 아니라 틀린 값 — 설정 적용이 꺼진다', async () => {
    mockServers(simApi());
    renderApp('/devices');
    const form = await screen.findByRole('form', { name: '시뮬레이터 설정' });
    await userEvent.clear(within(form).getByLabelText('대수'));
    expect(within(form).getByRole('button', { name: '설정 적용' })).toBeDisabled();
  });

  it('설정: 대수·주기(초)·펌웨어 실패율(%)을 바꾸면 바뀐 것만 서버 단위로 보낸다', async () => {
    const { calls } = mockServers({ ...simApi(), 'POST /sim/__admin/config': () => ({ body: simConfig({ count: 50, intervalMs: 5000, firmwareFailRate: 0.3 }) }) });
    renderApp('/devices');
    const form = await screen.findByRole('form', { name: '시뮬레이터 설정' });
    for (const [label, value] of [['대수', '50'], ['주기(초)', '5'], ['펌웨어 실패율(%)', '30']]) {
      await userEvent.clear(within(form).getByLabelText(label));
      await userEvent.type(within(form).getByLabelText(label), value);
    }
    await userEvent.click(within(form).getByRole('button', { name: '설정 적용' }));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ count: 50, intervalMs: 5000, firmwareFailRate: 0.3 });
  });

  it('서버가 거절하면(400) 그 이유를 보인다', async () => {
    mockServers({ ...simApi(), 'POST /sim/__admin/config': () => ({ status: 400, body: { error: 'BAD_CONFIG', message: 'count는 0~20000 정수입니다' } }) });
    renderApp('/devices');
    const form = await screen.findByRole('form', { name: '시뮬레이터 설정' });
    await userEvent.clear(within(form).getByLabelText('대수'));
    await userEvent.type(within(form).getByLabelText('대수'), '7');
    await userEvent.click(within(form).getByRole('button', { name: '설정 적용' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('count는 0~20000 정수입니다');
  });

  it('시뮬레이터가 안 떠 있으면 띄우는 명령을 안내한다', async () => {
    mockServers({ 'GET /sim/__admin/config': () => ({ status: 502 }), 'GET /sim/__admin/stats': () => ({ status: 502 }), 'GET /sim/__admin/devices': () => ({ status: 502 }) });
    renderApp('/devices');
    expect((await screen.findAllByRole('alert'))[0]).toHaveTextContent('단말기 시뮬레이터(:4020)에 연결하지 못했습니다');
  });
});
