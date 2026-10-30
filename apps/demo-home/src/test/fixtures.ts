import type { DashboardView, RolloutView, SyncRunView, TerminalView, TicketView } from '@terminal-ops/contracts';

export const terminal = (serialNo: string, status: TerminalView['status'], over: Partial<TerminalView> = {}): TerminalView => ({
  serialNo,
  modelCode: 'SN-100',
  merchantCode: null,
  status,
  statusChangedAt: '2026-10-30T00:00:00.000Z',
  version: 3,
  createdAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z',
  ...over,
});

export const dashboard = (over: Partial<DashboardView> = {}): DashboardView => ({
  terminals: { total: 22, byStatus: [{ status: 'IN_SERVICE', count: 12 }], byModel: [{ modelCode: 'SN-100', count: 21 }] },
  connectivity: { inService: 12, online: 11, offline: 1, noRecord: 0 },
  anomalies: {
    open: 2,
    byRule: [
      { rule: 'OFFLINE_TOO_LONG', label: '장기 오프라인', open: 1 },
      { rule: 'DELIVERED_NOT_INSTALLED', label: '배송 완료 후 미설치', open: 1 },
    ],
  },
  rollouts: { active: 1 },
  serviceTickets: { open: 2 },
  van: { runId: 1, finishedAt: '2026-10-30T00:00:00.000Z', confirmed: 4, counts: { NOT_REGISTERED: 2, MERCHANT_MISMATCH: 1, REGISTERED_BUT_NOT_IN_SERVICE: 1 } },
  week: { weekStart: '2026-10-26', transitions: 120 },
  cachedAt: '2026-10-30T00:00:00.000Z',
  fromCache: false,
  ...over,
});

export const rollout = (over: Partial<RolloutView> = {}): RolloutView => ({
  id: 3,
  modelCode: 'SN-100',
  version: '1.2.0',
  status: 'RUNNING',
  stages: [10, 50, 100],
  currentStage: 0,
  failureThreshold: 0.2,
  minSamples: 5,
  stageTimeoutMs: 600_000,
  stageStartedAt: '2026-10-30T00:00:00.000Z',
  createdBy: 'operator',
  createdAt: '2026-10-30T00:00:00.000Z',
  finishedAt: null,
  endReason: null,
  stageStats: [
    { stage: 0, percent: 10, targets: 2, offered: 2, succeeded: 1, failed: 0, timedOut: 0 },
    { stage: 1, percent: 50, targets: 0, offered: 0, succeeded: 0, failed: 0, timedOut: 0 },
    { stage: 2, percent: 100, targets: 0, offered: 0, succeeded: 0, failed: 0, timedOut: 0 },
  ],
  ...over,
});

export const syncRun = (over: Partial<SyncRunView> = {}): SyncRunView => ({
  id: 1,
  job: 'track-bungae',
  shipmentId: 9,
  trackingNo: 'BG1',
  attempt: 1,
  worker: 'worker-1',
  outcome: 'OK',
  startedAt: '2026-10-30T00:00:00.000Z',
  finishedAt: '2026-10-30T00:00:01.000Z',
  fetched: 1,
  inserted: 1,
  duplicated: 0,
  detail: null,
  ...over,
});

export const ticket = (over: Partial<TicketView> = {}): TicketView => ({
  id: 3,
  serialNo: 'DM-0004',
  merchantCode: 'GANGNAM-KIMBAP',
  symptom: '카드가 안 읽힘',
  status: 'OPEN',
  remoteNote: null,
  replacementSerialNo: null,
  outboundShipmentId: null,
  outboundTrackingNo: null,
  openedBy: 'merchant-gangnam',
  createdAt: '2026-10-30T00:00:00.000Z',
  closedAt: null,
  ...over,
});

const empty = { items: [], total: 0, page: 1, size: 20, nextBeforeId: null, afterId: null };

/** 막 화면들이 처음 읽는 것 — 테스트마다 필요한 것만 덮어쓴다 */
export const baseApi = () => ({
  'GET /auth/me': () => ({ status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' } }),
  'GET /dashboard/summary': () => ({ body: dashboard() }),
  'GET /anomalies': () => ({ body: { items: [], nextAfterId: null } }),
  'GET /purchase-orders': () => ({ body: { items: [], truncated: false } }),
  'GET /terminals': () => ({ body: empty }),
  'GET /sync-runs': () => ({ body: { items: [syncRun()], nextBeforeId: null } }),
  'GET /service-tickets': () => ({ body: { items: [], nextBeforeId: null } }),
  'GET /firmware-rollouts': () => ({ body: { items: [], nextBeforeId: null } }),
  'GET /partners/__admin/config': () => ({ body: { bungae: { force429Rate: 0 } } }),
  'GET /partners/__admin/requests': () => ({ body: { total: 0, items: [] } }),
  'GET /partners/__admin/toktok/messages': () => ({ body: { total: 0, messages: [] } }),
  'GET /sim/__admin/config': () => ({ body: { offlineSerials: ['DM-0002', 'DM-0021'], firmwareFailRate: 0 } }),
});
