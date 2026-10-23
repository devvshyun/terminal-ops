import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sleep, startFakeApi, startSim, type FakeApi } from './helpers.js';

describe('시뮬레이터 관리 API', () => {
  let api: FakeApi;
  let sim: Awaited<ReturnType<typeof startSim>>;

  beforeAll(async () => {
    api = await startFakeApi();
    sim = await startSim();
  });
  beforeEach(async () => {
    await sim.post('/__admin/reset');
    api.received.length = 0;
  });
  afterAll(async () => {
    await sim.close();
    await api.close();
  });

  it('health', async () => {
    expect(await sim.get('/__admin/health')).toEqual({ status: 'ok' });
  });

  it('설정은 일부만 바꿀 수 있고, 범위를 벗어나거나 JSON이 깨지면 400', async () => {
    const res = await sim.post('/__admin/config', { targetUrl: api.url, count: 3, batchSize: 2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ targetUrl: api.url, count: 3, batchSize: 2, intervalMs: 30_000 });
    expect((await sim.post('/__admin/config', { batchSize: 0 })).status).toBe(400);
    expect((await sim.post('/__admin/config', { offlineRate: 2 })).status).toBe(400);
    const broken = await fetch(`${sim.base}/__admin/config`, { method: 'POST', body: '{"count":' });
    expect(broken.status).toBe(400);
  });

  it('start → 주기마다 보냄 → stop, stats에 보낸 수와 응답 시간', async () => {
    await sim.post('/__admin/config', { targetUrl: api.url, count: 3, batchSize: 3, intervalMs: 50 });
    await sim.post('/__admin/start');
    await sleep(180);
    expect((await (await sim.post('/__admin/stop')).json()).running).toBe(false);
    const stats = await sim.get('/__admin/stats');
    expect(stats.running).toBe(false);
    expect(stats.ticks).toBeGreaterThanOrEqual(2);
    expect(stats.heartbeatsSent).toBe(stats.ticks * 3);
    expect(stats.heartbeatsAccepted).toBe(stats.heartbeatsSent);
    expect(stats.latency.count).toBe(stats.requests);
    const after = api.received.length;
    await sleep(120);
    expect(api.received.length).toBe(after); // 멈춘 뒤에는 보내지 않는다
  });

  it('단말기 상태 조회(없으면 404)', async () => {
    await sim.post('/__admin/config', { count: 2, serialPrefix: 'DV', firmwareVersion: '2.0.0' });
    expect(await sim.get('/__admin/devices/DV-0002')).toEqual({ serialNo: 'DV-0002', firmwareVersion: '2.0.0', offline: false });
    expect((await fetch(`${sim.base}/__admin/devices/NONE`)).status).toBe(404);
  });
});
