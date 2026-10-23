import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, serialsOf, type SimConfig } from '../src/config.js';
import { Fleet, pickSeeded } from '../src/fleet.js';
import { sendJson } from '../src/http.js';
import { okHandler, sleep, startFakeApi, type FakeApi } from './helpers.js';

describe('단말기 무리(Fleet)', () => {
  let api: FakeApi;
  let fleet: Fleet | undefined;
  const config = (patch: Partial<SimConfig>): SimConfig => ({ ...defaultConfig(), targetUrl: api.url, ...patch });

  beforeAll(async () => {
    api = await startFakeApi();
  });
  afterEach(async () => {
    await fleet?.close();
    fleet = undefined;
    api.received.length = 0;
    api.setHandler(okHandler);
  });
  afterAll(() => api.close());

  it('시리얼은 접두사·시작 번호·대수로 만든다(목록을 주면 그대로)', () => {
    expect(serialsOf({ ...defaultConfig(), serialPrefix: 'HB', serialStart: 9, count: 3 })).toEqual(['HB-0009', 'HB-0010', 'HB-0011']);
    expect(serialsOf({ ...defaultConfig(), serials: ['A-0001'] })).toEqual(['A-0001']);
  });

  it('한 주기에 온라인 단말기를 batchSize씩 묶어 보내고, 행별 결과를 센다', async () => {
    api.setHandler((req, res) => {
      const items = req.body.items as { serialNo: string }[];
      sendJson(res, 200, {
        results: items.map((i) => ({ serialNo: i.serialNo, result: i.serialNo === 'HB-0003' ? 'IGNORED_NOT_IN_SERVICE' : 'OK' })),
      });
    });
    fleet = new Fleet(config({ count: 5, batchSize: 2, firmwareVersion: '1.0.0' }));
    await fleet.tick();
    expect(api.received.map((r) => r.path)).toEqual(['/devices/heartbeats', '/devices/heartbeats', '/devices/heartbeats']);
    expect(api.received.map((r) => (r.body.items as unknown[]).length)).toEqual([2, 2, 1]);
    expect(api.received[0].body.items).toEqual([
      { serialNo: 'HB-0001', firmwareVersion: '1.0.0' },
      { serialNo: 'HB-0002', firmwareVersion: '1.0.0' },
    ]);
    expect(fleet.stats.view()).toMatchObject({ ticks: 1, requests: 3, heartbeatsSent: 5, heartbeatsAccepted: 4, heartbeatsRejected: 1, errors: 0 });
    expect(fleet.stats.view().latency.count).toBe(3);
  });

  it('오프라인 단말기는 보내지 않는다. offlineRate는 시드로 정해진 같은 단말기를 고른다', async () => {
    fleet = new Fleet(config({ count: 100, batchSize: 100, offlineSerials: ['HB-0001'], offlineRate: 0.1, seed: 7 }));
    const offline = [...fleet.devices.values()].filter((d) => d.offline).map((d) => d.serialNo);
    const picked = pickSeeded(serialsOf(fleet.config), 10, 7);
    expect(new Set(offline)).toEqual(new Set(['HB-0001', ...picked]));
    expect(pickSeeded(serialsOf(fleet.config), 10, 7)).toEqual(picked); // 같은 시드면 같은 단말기
    await fleet.tick();
    const sent = (api.received[0].body.items as { serialNo: string }[]).map((i) => i.serialNo);
    expect(sent).toHaveLength(100 - offline.length);
    expect(sent.some((s) => offline.includes(s))).toBe(false);
  });

  it('동시 요청은 concurrency를 넘지 않고, keep-alive라 소켓을 다시 쓴다', async () => {
    api.setHandler(async (req, res) => {
      await sleep(30);
      okHandler(req, res);
    });
    fleet = new Fleet(config({ count: 40, batchSize: 1, concurrency: 4 }));
    await fleet.tick();
    await fleet.tick();
    expect(api.received).toHaveLength(80);
    expect(api.maxInFlight()).toBeLessThanOrEqual(4);
    expect(new Set(api.received.map((r) => r.remotePort)).size).toBeLessThanOrEqual(4);
  });

  it('2xx가 아니거나 연결이 안 되면 errors로 센다', async () => {
    api.setHandler((_req, res) => sendJson(res, 500, { error: 'X' }));
    fleet = new Fleet(config({ count: 2, batchSize: 1 }));
    await fleet.tick();
    expect(fleet.stats.view()).toMatchObject({ requests: 2, errors: 2, heartbeatsAccepted: 0 });

    await fleet.close();
    fleet = new Fleet(config({ count: 1, targetUrl: 'http://127.0.0.1:1' }));
    await fleet.tick();
    expect(fleet.stats.view().errors).toBe(1);
  });

  it('start하면 주기마다 보내고, 앞 주기가 안 끝났으면 그 주기는 건너뛴다(skippedTicks)', async () => {
    api.setHandler(async (req, res) => {
      await sleep(120);
      okHandler(req, res);
    });
    fleet = new Fleet(config({ count: 1, intervalMs: 50 }));
    fleet.start();
    await sleep(300);
    await fleet.stop();
    const s = fleet.stats.view();
    expect(s.ticks).toBeGreaterThanOrEqual(2);
    expect(s.skippedTicks).toBeGreaterThanOrEqual(1);
    expect(fleet.running).toBe(false);
  });

  it('stop은 주기 도중에도 새 묶음을 보내지 않고, 보내는 중인 요청만 기다린다', async () => {
    api.setHandler(async (req, res) => {
      await sleep(200);
      okHandler(req, res);
    });
    // 묶음 20개, 동시 2개 → 한 주기가 약 2초. 예전에는 stop이 주기가 끝나길(2초) 기다렸다
    fleet = new Fleet(config({ count: 20, batchSize: 1, concurrency: 2, intervalMs: 60_000 }));
    fleet.start();
    await sleep(250);
    const t0 = performance.now();
    await fleet.stop();
    const took = performance.now() - t0;
    expect(took).toBeLessThan(400);
    const after = api.received.length;
    expect(after).toBeLessThan(20);
    await sleep(500);
    expect(api.received.length).toBe(after); // stop이 끝난 뒤에는 보내지 않는다
    expect(fleet.running).toBe(false);
    // 다시 시작하면 새 주기를 처음부터 보낸다
    api.setHandler(okHandler);
    api.received.length = 0;
    fleet.start();
    await sleep(300);
    await fleet.stop();
    expect(api.received.length).toBe(20);
  });

  it('시간 초과는 timeouts로 세고, 걸린 시간도 실패 응답 시간에 남긴다', async () => {
    api.setHandler(async (req, res) => {
      await sleep(400);
      okHandler(req, res);
    });
    fleet = new Fleet(config({ count: 1, requestTimeoutMs: 100 }));
    await fleet.tick();
    const v = fleet.stats.view();
    expect(v).toMatchObject({ requests: 1, errors: 1, timeouts: 1, networkErrors: 0, httpErrors: 0, badResponses: 0 });
    expect(v.latencyFailed.count).toBe(1);
    expect(v.latencyFailed.max).toBeGreaterThanOrEqual(90);
    expect(v.latencyFailed.max).toBeLessThan(350);
    expect(v.latencyOk.count).toBe(0);
    expect(v.latency.count).toBe(1);
  });

  it('연결 실패는 networkErrors, 2xx가 아닌 응답은 httpErrors(응답 시간은 실패 쪽)', async () => {
    api.setHandler((_req, res) => sendJson(res, 503, { error: 'X' }));
    fleet = new Fleet(config({ count: 2, batchSize: 1 }));
    await fleet.tick();
    expect(fleet.stats.view()).toMatchObject({ errors: 2, httpErrors: 2, timeouts: 0, networkErrors: 0 });
    expect(fleet.stats.view().latencyFailed.count).toBe(2);
    await fleet.close();
    fleet = new Fleet(config({ count: 1, targetUrl: 'http://127.0.0.1:1' }));
    await fleet.tick();
    expect(fleet.stats.view()).toMatchObject({ errors: 1, networkErrors: 1, httpErrors: 0 });
    expect(fleet.stats.view().latencyFailed.count).toBe(1);
  });

  it('2xx인데 results 배열이 없으면 badResponses이자 오류다(성공 응답 시간에는 넣지 않는다)', async () => {
    api.setHandler((_req, res) => sendJson(res, 200, { accepted: 1 }));
    fleet = new Fleet(config({ count: 2, batchSize: 1 }));
    await fleet.tick();
    const v = fleet.stats.view();
    expect(v).toMatchObject({ requests: 2, errors: 2, badResponses: 2, httpErrors: 0, heartbeatsAccepted: 0 });
    expect(v.latencyOk.count).toBe(0);
    expect(v.latencyFailed.count).toBe(2);
  });

  it('configure가 중간에 실패하면 이전 설정·단말기를 그대로 둔다', () => {
    fleet = new Fleet(config({ count: 3, serialPrefix: 'KEEP' }));
    const before = { config: fleet.config, devices: fleet.devices };
    expect(() => fleet!.configure({ ...fleet!.config, targetUrl: 'not a url', count: 9 })).toThrow();
    expect(fleet.config).toBe(before.config);
    expect(fleet.devices).toBe(before.devices);
    expect([...fleet.devices.keys()]).toEqual(['KEEP-0001', 'KEEP-0002', 'KEEP-0003']);
  });
});
