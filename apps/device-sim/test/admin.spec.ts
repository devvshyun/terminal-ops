import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { okHandler, sleep, startFakeApi, startSim, type FakeApi } from './helpers.js';

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
    expect((await sim.post('/__admin/config', { firmwareFailRate: -0.1 })).status).toBe(400);
    expect((await sim.post('/__admin/config', { updateDelayMs: -1 })).status).toBe(400);
    expect((await sim.post('/__admin/config', { updateJitterMs: 1.5 })).status).toBe(400);
    const fw = await sim.post('/__admin/config', { firmwareFailRate: 0.5, updateDelayMs: 0, updateJitterMs: 10 });
    expect(fw.status).toBe(200);
    expect(await fw.json()).toMatchObject({ firmwareFailRate: 0.5, updateDelayMs: 0, updateJitterMs: 10 });
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
    expect(await sim.get('/__admin/devices/DV-0002')).toEqual({ serialNo: 'DV-0002', firmwareVersion: '2.0.0', offline: false, updating: false });
    expect((await fetch(`${sim.base}/__admin/devices/NONE`)).status).toBe(404);
  });

  it('설정 검증: 형식·범위·알 수 없는 키는 400이고, 400이면 설정이 그대로다', async () => {
    const before = await sim.get('/__admin/config');
    const bad: Record<string, unknown>[] = [
      { serials: 'HB-0001' },
      { serials: [1, 2] },
      { offlineSerials: [null] },
      { serials: ['A', 'A'] },
      { count: 20_001 },
      { count: -1 },
      { count: 1.5 },
      { count: '5' },
      { count: null },
      { intervalMs: 0 },
      { batchSize: 501 },
      { concurrency: 0 },
      { concurrency: 100_000 },
      { requestTimeoutMs: Number.MAX_SAFE_INTEGER },
      { targetUrl: 'not a url' },
      { targetUrl: 'ftp://127.0.0.1/x' },
      { targetUrl: 5 },
      { offlineRate: -0.1 },
      { offlineRate: '0.5' },
      { seed: 1.5 },
      { serialPrefix: 7 },
      { firmwareVersion: '' },
      { nope: 1 },
    ];
    for (const patch of bad) {
      const res = await sim.post('/__admin/config', patch);
      expect(res.status, JSON.stringify(patch)).toBe(400);
    }
    expect(await sim.get('/__admin/config')).toEqual(before);
    expect((await sim.post('/__admin/config', { count: 20_000, targetUrl: 'https://example.test:8443/' })).status).toBe(200);
  });

  it('본문이 배열이거나 JSON 객체가 아니거나(숫자·true·문자열·null) __proto__ 키가 있으면 400', async () => {
    const arr = await fetch(`${sim.base}/__admin/config`, { method: 'POST', body: '[]' });
    expect(arr.status).toBe(400);
    for (const body of ['5', 'true', '"count"', 'null']) {
      expect((await fetch(`${sim.base}/__admin/config`, { method: 'POST', body })).status, body).toBe(400);
    }
    const proto = await fetch(`${sim.base}/__admin/config`, { method: 'POST', body: '{"__proto__":{"count":1}}' });
    expect(proto.status).toBe(400);
  });

  it('동시에 온 POST /config는 차례로 처리해 서로의 변경을 덮어쓰지 않는다', async () => {
    await sim.post('/__admin/config', { targetUrl: api.url, intervalMs: 50, count: 2 });
    await sim.post('/__admin/start');
    const results = await Promise.all([
      sim.post('/__admin/config', { count: 5 }),
      sim.post('/__admin/config', { batchSize: 7 }),
      sim.post('/__admin/config', { firmwareVersion: '9.9.9' }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await sim.get('/__admin/config')).toMatchObject({ count: 5, batchSize: 7, firmwareVersion: '9.9.9' });
    expect(sim.fleet.running).toBe(true);
  });

  it('설정 적용이 도중에 실패하면 이전 설정을 두고, 돌던 중이었으면 다시 돈다', async () => {
    await sim.post('/__admin/config', { targetUrl: api.url, intervalMs: 50, count: 2 });
    await sim.post('/__admin/start');
    const spy = vi.spyOn(sim.fleet, 'configure').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const res = await sim.post('/__admin/config', { count: 8 });
    expect(res.status).toBe(500);
    spy.mockRestore();
    expect(await sim.get('/__admin/config')).toMatchObject({ count: 2 });
    expect(sim.fleet.running).toBe(true);
    api.received.length = 0;
    await sleep(150);
    expect(api.received.length).toBeGreaterThan(0); // 루프가 다시 돌고 있다
  });

  it('stop은 주기 도중에 끊는다(새 묶음을 보내지 않는다)', async () => {
    api.setHandler(async (req, res) => {
      await sleep(150);
      okHandler(req, res);
    });
    await sim.post('/__admin/config', { targetUrl: api.url, count: 20, batchSize: 1, concurrency: 2, intervalMs: 60_000 });
    await sim.post('/__admin/start');
    await sleep(200);
    const t0 = performance.now();
    await sim.post('/__admin/stop');
    expect(performance.now() - t0).toBeLessThan(350);
    const n = api.received.length;
    await sleep(400);
    expect(api.received.length).toBe(n);
    api.setHandler(okHandler);
  });
});
