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
});
