import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeApi, startSim, type FakeApi } from './helpers.js';

/** 시연 도구의 단말기 표(보강 8, decisions/0085): 수 넷과 시리얼 순 앞 limit대 */
describe('GET /__admin/devices', () => {
  let api: FakeApi;
  let sim: Awaited<ReturnType<typeof startSim>>;

  beforeAll(async () => {
    api = await startFakeApi();
    sim = await startSim();
  });
  beforeEach(async () => {
    await sim.post('/__admin/reset');
  });
  afterAll(async () => {
    await sim.close();
    await api.close();
  });

  const devices = async (query = '') => (await fetch(`${sim.base}/__admin/devices${query}`)).json();

  it('전체·온라인·오프라인·업데이트 중 수와 단말기(시리얼 순, 기본 100대)', async () => {
    await sim.post('/__admin/config', { targetUrl: api.url, count: 3, offlineSerials: ['HB-0002'] });
    expect(await devices()).toEqual({
      total: 3,
      online: 2,
      offline: 1,
      updating: 0,
      items: [
        { serialNo: 'HB-0001', firmwareVersion: '1.0.0', offline: false, updating: false },
        { serialNo: 'HB-0002', firmwareVersion: '1.0.0', offline: true, updating: false },
        { serialNo: 'HB-0003', firmwareVersion: '1.0.0', offline: false, updating: false },
      ],
    });
  });

  it('limit: 앞에서 그만큼(수는 전체), 1~1000 정수가 아니면 400', async () => {
    await sim.post('/__admin/config', { targetUrl: api.url, count: 150 });
    const page = await devices();
    expect([page.total, page.items.length, page.items[99].serialNo]).toEqual([150, 100, 'HB-0100']);
    expect((await devices('?limit=5')).items.map((d: { serialNo: string }) => d.serialNo)).toEqual(['HB-0001', 'HB-0002', 'HB-0003', 'HB-0004', 'HB-0005']);
    for (const bad of ['0', '1001', 'x', '2.5']) expect((await fetch(`${sim.base}/__admin/devices?limit=${bad}`)).status, bad).toBe(400);
  });

  it('시리얼 목록(serials)을 주면 그 순서가 아니라 시리얼 순으로', async () => {
    await sim.post('/__admin/config', { targetUrl: api.url, serials: ['SN-3', 'SN-1', 'SN-2'] });
    expect((await devices()).items.map((d: { serialNo: string }) => d.serialNo)).toEqual(['SN-1', 'SN-2', 'SN-3']);
  });
});
