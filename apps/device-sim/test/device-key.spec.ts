import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultConfig, type SimConfig } from '../src/config.js';
import { Fleet } from '../src/fleet.js';
import { okHandler, startFakeApi, startSim, type FakeApi } from './helpers.js';

describe('단말기 키 X-Device-Key (api decisions/0055)', () => {
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
    vi.unstubAllEnvs();
  });
  afterAll(() => api.close());

  it('키가 있으면 모든 하트비트 요청에 X-Device-Key, 없으면 헤더를 보내지 않는다', async () => {
    fleet = new Fleet(config({ count: 3, batchSize: 2, deviceKey: 'sim-key-0123456789' }));
    await fleet.tick();
    expect(api.received.map((r) => r.headers['x-device-key'])).toEqual(['sim-key-0123456789', 'sim-key-0123456789']);
    await fleet.close();
    api.received.length = 0;
    fleet = new Fleet(config({ count: 1, deviceKey: '' }));
    await fleet.tick();
    expect(api.received[0].headers['x-device-key']).toBeUndefined();
  });

  it('기본 키는 환경변수 DEVICE_API_KEY', () => {
    vi.stubEnv('DEVICE_API_KEY', 'env-key-0123456789');
    expect(defaultConfig().deviceKey).toBe('env-key-0123456789');
  });

  it('관리 API는 키를 받지만 보여 줄 때는 "(설정됨)"으로 가린다', async () => {
    const sim = await startSim();
    try {
      const res = await sim.post('/__admin/config', { targetUrl: api.url, deviceKey: 'secret-key-0123456789' });
      expect(res.status).toBe(200);
      const text = JSON.stringify(await res.json()) + JSON.stringify(await sim.get('/__admin/config'));
      expect(text).not.toContain('secret-key-0123456789');
      expect((await sim.get('/__admin/config')).deviceKey).toBe('(설정됨)');
      expect(sim.fleet.config.deviceKey).toBe('secret-key-0123456789');
      expect((await sim.post('/__admin/config', { deviceKey: 5 })).status).toBe(400);
    } finally {
      await sim.close();
    }
  });
});
