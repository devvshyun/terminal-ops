/**
 * 두 서버 관리 API의 응답 모양(보강 8). 가상 업체·시뮬레이터는 api가 아니라 contracts에 없다 —
 * 서버 쪽 정의(apps/partners/src/state.ts·requests.ts, apps/device-sim/src/config.ts·stats.ts·fleet.ts)를 이 화면이 쓰는 만큼만 옮겼다.
 */
export type PartnerKey = 'bungae' | 'neurimbo' | 'toktok' | 'seum' | 'bridgevan';

/** GET·POST /__admin/config — 업체마다 숫자·참거짓 손잡이 */
export type PartnersConfig = { seed: number } & Record<PartnerKey, Record<string, number | boolean>>;

export interface RequestRow {
  id: number;
  at: string;
  partner: string;
  method: string;
  path: string;
  status: number;
  ms: number;
}

export interface RequestsPage {
  total: number;
  items: RequestRow[];
}

export interface ToktokMessages {
  total: number;
  messages: { channel: string; idempotencyKey: string; text: string; receivedAt: string; attachments: { fileName: string; size: number }[] }[];
}

/** 시뮬레이터 설정(GET·POST /__admin/config). 단말기 키는 `(설정됨)`으로 가려 온다 */
export interface SimConfig {
  targetUrl: string;
  deviceKey: string;
  serials: string[];
  serialPrefix: string;
  serialStart: number;
  count: number;
  intervalMs: number;
  batchSize: number;
  concurrency: number;
  offlineSerials: string[];
  offlineRate: number;
  firmwareVersion: string;
  firmwareFailRate: number;
  updateDelayMs: number;
  updateJitterMs: number;
  requestTimeoutMs: number;
  seed: number;
}

export interface Latency {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export interface SimStats {
  running: boolean;
  ticks: number;
  skippedTicks: number;
  requests: number;
  heartbeatsSent: number;
  heartbeatsAccepted: number;
  heartbeatsRejected: number;
  errors: number;
  latency: Latency;
  updateOffers: number;
  reportsSucceeded: number;
  reportsFailed: number;
  startedAt: string | null;
  lastTickAt: string | null;
}

export interface SimDevice {
  serialNo: string;
  firmwareVersion: string;
  offline: boolean;
  updating: boolean;
}

export interface SimDevices {
  total: number;
  online: number;
  offline: number;
  updating: number;
  items: SimDevice[];
}
