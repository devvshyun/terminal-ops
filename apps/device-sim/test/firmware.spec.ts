import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, type SimConfig } from '../src/config.js';
import { Fleet } from '../src/fleet.js';
import { sendJson } from '../src/http.js';
import { okHandler, sleep, startFakeApi, type FakeApi } from './helpers.js';

/** HB-0001에만 업데이트 지시(배포 7, 버전 2.0.0)를 싣는 하트비트 응답. 보고는 200 */
const offeringHandler: Parameters<FakeApi['setHandler']>[0] = (req, res) => {
  if (req.path === '/devices/firmware-reports') return sendJson(res, 200, { status: 'SUCCEEDED' });
  const items = req.body.items as { serialNo: string }[];
  sendJson(res, 200, {
    results: items.map((i) => ({ serialNo: i.serialNo, result: 'OK', ...(i.serialNo === 'HB-0001' ? { update: { rolloutId: 7, version: '2.0.0' } } : {}) })),
  });
};

describe('펌웨어 업데이트 흉내', () => {
  let api: FakeApi;
  let fleet: Fleet | undefined;
  const config = (patch: Partial<SimConfig>): SimConfig => ({ ...defaultConfig(), targetUrl: api.url, count: 2, batchSize: 2, ...patch });
  const reports = () => api.received.filter((r) => r.path === '/devices/firmware-reports').map((r) => r.body);
  const heartbeats = () => api.received.filter((r) => r.path === '/devices/heartbeats');

  beforeAll(async () => {
    api = await startFakeApi(offeringHandler);
  });
  afterEach(async () => {
    await fleet?.close();
    fleet = undefined;
    api.received.length = 0;
    api.setHandler(offeringHandler);
  });
  afterAll(() => api.close());

  it('지시를 받으면 updateDelayMs 뒤 성공을 보고하고, 다음 하트비트부터 새 버전을 보낸다', async () => {
    fleet = new Fleet(config({ updateDelayMs: 50 }));
    await fleet.tick();
    expect(fleet.devices.get('HB-0001')!.updating).toBe(true);
    expect(reports()).toEqual([]); // 아직 업데이트 중
    await fleet.settleUpdates();
    expect(reports()).toEqual([{ serialNo: 'HB-0001', rolloutId: 7, success: true, version: '2.0.0' }]);
    expect(fleet.devices.get('HB-0001')).toMatchObject({ firmwareVersion: '2.0.0', updating: false });
    expect(fleet.stats.view()).toMatchObject({ updateOffers: 1, reportsSucceeded: 1, reportsFailed: 0, reportErrors: 0 });

    api.setHandler(okHandler);
    await fleet.tick();
    expect(heartbeats().at(-1)!.body.items).toEqual([
      { serialNo: 'HB-0001', firmwareVersion: '2.0.0' },
      { serialNo: 'HB-0002', firmwareVersion: '1.0.0' },
    ]);
  });

  it('이미 그 버전이면 지시를 무시한다', async () => {
    fleet = new Fleet(config({ updateDelayMs: 0, firmwareVersion: '2.0.0' }));
    await fleet.tick();
    await fleet.settleUpdates();
    expect(reports()).toEqual([]);
    expect(fleet.stats.view().updateOffers).toBe(0);
  });

  it('firmwareFailRate 1이면 실패를 보고하고 버전은 그대로', async () => {
    fleet = new Fleet(config({ updateDelayMs: 0, firmwareFailRate: 1 }));
    await fleet.tick();
    await fleet.settleUpdates();
    expect(reports()).toEqual([{ serialNo: 'HB-0001', rolloutId: 7, success: false, version: '2.0.0' }]);
    expect(fleet.devices.get('HB-0001')!.firmwareVersion).toBe('1.0.0');
    expect(fleet.stats.view()).toMatchObject({ reportsSucceeded: 0, reportsFailed: 1 });
  });

  it('업데이트 중에 같은 지시가 또 와도 한 번만 한다', async () => {
    fleet = new Fleet(config({ updateDelayMs: 100 }));
    await fleet.tick();
    await fleet.tick();
    await fleet.settleUpdates();
    expect(reports()).toHaveLength(1);
    expect(fleet.stats.view().updateOffers).toBe(1);
  });

  it('실패율은 시드로 재현된다(같은 시드면 같은 단말기가 실패)', async () => {
    const run = async () => {
      api.setHandler((req, res) => {
        if (req.path === '/devices/firmware-reports') return sendJson(res, 200, {});
        const items = req.body.items as { serialNo: string }[];
        sendJson(res, 200, { results: items.map((i) => ({ serialNo: i.serialNo, result: 'OK', update: { rolloutId: 1, version: '2.0.0' } })) });
      });
      api.received.length = 0;
      const f = new Fleet(config({ count: 50, batchSize: 50, updateDelayMs: 0, firmwareFailRate: 0.3, seed: 11 }));
      await f.tick();
      await f.settleUpdates();
      await f.close();
      return reports()
        .filter((r) => r.success === false)
        .map((r) => r.serialNo)
        .sort();
    };
    const first = await run();
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(50);
    expect(await run()).toEqual(first);
  });

  it('updateJitterMs가 있으면 보고 시각이 퍼진다', async () => {
    const reportedAt: number[] = [];
    api.setHandler((req, res) => {
      if (req.path === '/devices/firmware-reports') {
        reportedAt.push(Date.now());
        return sendJson(res, 200, {});
      }
      const items = req.body.items as { serialNo: string }[];
      sendJson(res, 200, { results: items.map((i) => ({ serialNo: i.serialNo, result: 'OK', update: { rolloutId: 1, version: '2.0.0' } })) });
    });
    fleet = new Fleet(config({ count: 20, batchSize: 20, updateDelayMs: 0, updateJitterMs: 300 }));
    await fleet.tick();
    await fleet.settleUpdates();
    expect(reportedAt).toHaveLength(20);
    expect(Math.max(...reportedAt) - Math.min(...reportedAt)).toBeGreaterThan(100);
  });

  it('보고가 2xx가 아니면 reportErrors, 다음 지시에 다시 업데이트한다', async () => {
    api.setHandler((req, res) => (req.path === '/devices/firmware-reports' ? sendJson(res, 503, {}) : offeringHandler(req, res)));
    fleet = new Fleet(config({ updateDelayMs: 0 }));
    await fleet.tick();
    await fleet.settleUpdates();
    expect(fleet.stats.view().reportErrors).toBe(1);
    expect(fleet.devices.get('HB-0001')).toMatchObject({ firmwareVersion: '1.0.0', updating: false });
    await sleep(10);
    await fleet.tick();
    await fleet.settleUpdates();
    expect(fleet.stats.view().updateOffers).toBe(2);
  });

  it('업데이트 중에 설정을 바꿔도(단말기 목록을 새로 만듦) 보고 결과가 지금 목록의 단말기에 반영된다', async () => {
    fleet = new Fleet(config({ updateDelayMs: 50 }));
    await fleet.tick();
    expect(fleet.devices.get('HB-0001')!.updating).toBe(true);
    fleet.configure({ ...fleet.config, intervalMs: 1234 }); // 같은 단말기, 새 Device 객체
    await fleet.settleUpdates();
    expect(fleet.devices.get('HB-0001')).toMatchObject({ firmwareVersion: '2.0.0', updating: false });
  });
  it('보고가 가는 중에 reset하면 그 보고는 새 통계·새 단말기에 반영되지 않는다(세대 토큰)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    api.setHandler(async (req, res) => {
      if (req.path === '/devices/firmware-reports') {
        await gate;
        return sendJson(res, 200, {});
      }
      return offeringHandler(req, res);
    });
    fleet = new Fleet(config({ updateDelayMs: 0 }));
    await fleet.tick();
    while (reports().length === 0) await sleep(5); // 보고 요청이 서버에 닿았다(응답은 gate에서 멈춤)
    await fleet.reset(config({ updateDelayMs: 0 }));
    release();
    await sleep(50);
    expect(fleet.stats.view()).toMatchObject({ updateOffers: 0, reportsSucceeded: 0, reportsFailed: 0, reportErrors: 0 });
    expect(fleet.devices.get('HB-0001')).toMatchObject({ firmwareVersion: '1.0.0', updating: false });
  });

  it('close는 settleUpdates를 기다리던 쪽을 풀어 준다(버린 업데이트 타이머)', async () => {
    fleet = new Fleet(config({ updateDelayMs: 10_000 }));
    await fleet.tick();
    const settled = fleet.settleUpdates().then(() => 'settled');
    await fleet.close();
    expect(await Promise.race([settled, sleep(500).then(() => 'hang')])).toBe('settled');
  });

  it('지터·실패율이 있어도 같은 시드면 단말기별 결과가 같다(타이머가 끝나는 순서와 상관없이)', async () => {
    // 두 번째 묶음의 응답만 늦춘 실행과 늦추지 않은 실행: 지시를 받는 단말기 순서는 같고, 첫 묶음 타이머가 끝나는 시점만 다르다
    const run = async (delaySecondBatchMs: number) => {
      let batch = 0;
      api.setHandler(async (req, res) => {
        if (req.path === '/devices/firmware-reports') return sendJson(res, 200, {});
        batch += 1;
        if (batch === 2) await sleep(delaySecondBatchMs);
        const items = req.body.items as { serialNo: string }[];
        sendJson(res, 200, { results: items.map((i) => ({ serialNo: i.serialNo, result: 'OK', update: { rolloutId: 1, version: '2.0.0' } })) });
      });
      api.received.length = 0;
      const f = new Fleet(config({ count: 20, batchSize: 10, concurrency: 1, updateDelayMs: 50, updateJitterMs: 30, firmwareFailRate: 0.5, seed: 7 }));
      await f.tick();
      await f.settleUpdates();
      await f.close();
      return Object.fromEntries(reports().map((r) => [r.serialNo as string, r.success as boolean]));
    };
    const fast = await run(0);
    expect(Object.keys(fast)).toHaveLength(20);
    expect(await run(200)).toEqual(fast);
  });

  it('concurrency 8·응답 지연이 무작위여도 같은 시드면 단말기별 결과가 같다((시드, 시리얼, 배포)의 결정적 함수)', async () => {
    const run = async () => {
      api.setHandler(async (req, res) => {
        if (req.path === '/devices/firmware-reports') return sendJson(res, 200, {});
        await sleep(Math.floor(Math.random() * 40)); // 묶음마다 응답 순서가 실행마다 달라진다
        const items = req.body.items as { serialNo: string }[];
        sendJson(res, 200, { results: items.map((i) => ({ serialNo: i.serialNo, result: 'OK', update: { rolloutId: 3, version: '2.0.0' } })) });
      });
      api.received.length = 0;
      const f = new Fleet(config({ count: 80, batchSize: 5, concurrency: 8, updateDelayMs: 0, updateJitterMs: 30, firmwareFailRate: 0.5, seed: 9 }));
      await f.tick();
      await f.settleUpdates();
      await f.close();
      return Object.fromEntries(reports().map((r) => [r.serialNo as string, r.success as boolean]));
    };
    const first = await run();
    expect(Object.keys(first)).toHaveLength(80);
    const failed = Object.values(first).filter((s) => !s).length;
    expect(failed).toBeGreaterThan(20);
    expect(failed).toBeLessThan(60);
    expect(await run()).toEqual(first);
    expect(await run()).toEqual(first);
  });

  it('다른 배포(rolloutId)면 같은 단말기라도 결과를 따로 정한다', async () => {
    const run = async (rolloutId: number) => {
      api.setHandler((req, res) => {
        if (req.path === '/devices/firmware-reports') return sendJson(res, 200, {});
        const items = req.body.items as { serialNo: string }[];
        sendJson(res, 200, { results: items.map((i) => ({ serialNo: i.serialNo, result: 'OK', update: { rolloutId, version: '2.0.0' } })) });
      });
      api.received.length = 0;
      const f = new Fleet(config({ count: 40, batchSize: 40, updateDelayMs: 0, firmwareFailRate: 0.5, seed: 9 }));
      await f.tick();
      await f.settleUpdates();
      await f.close();
      return Object.fromEntries(reports().map((r) => [r.serialNo as string, r.success as boolean]));
    };
    expect(await run(1)).not.toEqual(await run(2));
  });

  it('업데이트 중인 단말기가 목록에서 빠졌다 다시 들어와도 업데이트를 두 번 하지 않는다', async () => {
    fleet = new Fleet(config({ updateDelayMs: 100 }));
    await fleet.tick();
    fleet.configure({ ...fleet.config, serials: ['HB-0002'] });
    fleet.configure({ ...fleet.config, serials: ['HB-0001', 'HB-0002'] });
    expect(fleet.devices.get('HB-0001')!.updating).toBe(true);
    await fleet.tick();
    await fleet.settleUpdates();
    expect(fleet.stats.view().updateOffers).toBe(1);
    expect(reports()).toHaveLength(1);
  });
});
