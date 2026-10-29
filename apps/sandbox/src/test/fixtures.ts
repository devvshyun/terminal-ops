import type { PartnersConfig, RequestRow, SimConfig, SimDevices, SimStats } from '../lib/types';

/** 가상 업체 서버 기본 설정(apps/partners/src/state.ts defaultConfig와 같은 값 — 화면 테스트에 필요한 만큼) */
export const partnersConfig = (over: Partial<Record<keyof PartnersConfig, object>> = {}): PartnersConfig =>
  ({
    seed: 1,
    bungae: { advancePerPoll: 1, duplicateRate: 0, rateLimitPerSec: 10, force429Rate: 0, retryAfterSec: 1, delayMs: 0, ...over.bungae },
    neurimbo: { advancePerPoll: 1, delayMs: 0, error5xxRate: 0, shuffle: false, ...over.neurimbo },
    toktok: { failRate: 0, hookFailRate: 0, maxFileBytes: 1_048_576, delayMs: 0, ...over.toktok },
    seum: { shortfall: 0, foreignSerials: 0, error5xxRate: 0, ...over.seum },
    bridgevan: { maxLimit: 500, delayMs: 0, error5xxRate: 0, force429Rate: 0, retryAfterSec: 1, mutateDuringScan: 0, ...over.bridgevan },
  }) as PartnersConfig;

export const request = (over: Partial<RequestRow> = {}): RequestRow => ({
  id: 1,
  at: new Date().toISOString(),
  partner: 'bungae',
  method: 'GET',
  path: '/bungae/v1/trackings/510233812290',
  status: 200,
  ms: 3,
  ...over,
});

export const partnersApi = (config = partnersConfig(), requests: RequestRow[] = [request()]) => ({
  'GET /partners/__admin/config': () => ({ body: config }),
  'GET /partners/__admin/requests': () => ({ body: { total: requests.length, items: requests } }),
  'GET /partners/__admin/toktok/messages': () => ({ body: { total: 0, byKey: {}, messages: [], files: 0 } }),
});

export const simConfig = (over: Partial<SimConfig> = {}): SimConfig => ({
  targetUrl: 'http://127.0.0.1:3000',
  deviceKey: '(설정됨)',
  serials: [],
  serialPrefix: 'HB',
  serialStart: 1,
  count: 3,
  intervalMs: 30_000,
  batchSize: 100,
  concurrency: 8,
  offlineSerials: [],
  offlineRate: 0,
  firmwareVersion: '1.0.0',
  firmwareFailRate: 0,
  updateDelayMs: 1000,
  updateJitterMs: 0,
  requestTimeoutMs: 5000,
  seed: 42,
  ...over,
});

export const simStats = (over: Partial<SimStats> = {}): SimStats => ({
  running: false,
  ticks: 0,
  skippedTicks: 0,
  requests: 0,
  heartbeatsSent: 0,
  heartbeatsAccepted: 0,
  heartbeatsRejected: 0,
  errors: 0,
  latency: { count: 0, p50: 0, p95: 0, max: 0 },
  updateOffers: 0,
  reportsSucceeded: 0,
  reportsFailed: 0,
  startedAt: null,
  lastTickAt: null,
  ...over,
});

export const simDevices = (offline: string[] = []): SimDevices => {
  const items = ['HB-0001', 'HB-0002', 'HB-0003'].map((serialNo) => ({ serialNo, firmwareVersion: '1.0.0', offline: offline.includes(serialNo), updating: false }));
  return { total: 3, online: 3 - offline.length, offline: offline.length, updating: 0, items };
};

export const simApi = (config = simConfig(), stats = simStats(), devices = simDevices(config.offlineSerials)) => ({
  'GET /sim/__admin/config': () => ({ body: config }),
  'GET /sim/__admin/stats': () => ({ body: stats }),
  'GET /sim/__admin/devices': () => ({ body: devices }),
});
