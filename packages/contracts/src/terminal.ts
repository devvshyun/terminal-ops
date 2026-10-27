import type { OffsetPage } from './common.js';
import type { Carrier, ShipmentStatus, TerminalStatus, TransitionSource } from './statuses.js';

/** 단말기(api toTerminalView). 시각은 모두 ISO 문자열 */
export interface TerminalView {
  serialNo: string;
  modelCode: string;
  merchantCode: string | null;
  status: TerminalStatus;
  /** 지금 상태가 된 시각(decisions/0034) */
  statusChangedAt: string;
  /** 낙관적 락 버전 — 쓰기 요청의 expectedVersion(decisions/0004) */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** GET /terminals */
export type TerminalPage = OffsetPage<TerminalView>;

/** 지금 상태에서 일반 전이로 갈 수 있는 상태. 모델 정책에 막혔으면 이유(decisions/0040) */
export interface TransitionTarget {
  to: TerminalStatus;
  blockedReason: string | null;
}

/** 전용 API로만 하는 일을 지금 할 수 있는지(decisions/0040) */
export interface TerminalActionFlags {
  allocate: boolean;
  cancelAllocation: boolean;
  ship: boolean;
  inspect: boolean;
}

/** GET /terminals/:serialNo (api toTerminalDetailView) */
export interface TerminalDetail extends TerminalView {
  modelName: string;
  merchantName: string | null;
  allowedTransitions: TransitionTarget[];
  actions: TerminalActionFlags;
}

/** GET /terminals/:serialNo/history (api toHistoryView) */
export interface HistoryView {
  fromStatus: TerminalStatus | null;
  toStatus: TerminalStatus;
  source: TransitionSource;
  actor: string;
  reason: string;
  occurredAt: string;
}

/** GET /terminals/:serialNo/connectivity — redis: 하트비트 최신값, snapshot: MySQL 스냅샷, none: 기록 없음(decisions/0029) */
export interface ConnectivityView {
  serialNo: string;
  source: 'redis' | 'snapshot' | 'none';
  online: boolean;
  lastSeenAt: string | null;
  firmwareVersion: string | null;
}

/** GET /terminals/:serialNo/inspections 한 건(최근 것부터). 항목 이름(label)을 붙여 준다 */
export interface InspectionRecord {
  id: number;
  passed: boolean;
  actor: string;
  inspectedAt: string;
  results: { itemCode: string; label: string; passed: boolean; note: string | null }[];
}

/** POST /terminals/:serialNo/inspections 응답 */
export interface InspectResult {
  inspectionId: number;
  passed: boolean;
  failedItems: string[];
  terminal: TerminalView;
}

/** GET /inspection-items?modelCode= */
export interface InspectionItemView {
  code: string;
  label: string;
  sortOrder: number;
}

/** GET /merchants */
export interface MerchantView {
  code: string;
  name: string;
  address: string;
}

/** GET /terminal-models */
export interface TerminalModelView {
  code: string;
  name: string;
  requiresReinspection: boolean;
}

/** 운송장(api toShipmentView). events는 GET /shipments/:id에만 */
export interface ShipmentView {
  id: number;
  serialNo: string;
  carrier: Carrier;
  trackingNo: string;
  status: ShipmentStatus;
  lastSyncedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  events?: { eventKey: string; code: string; occurredAt: string }[];
}

/** POST /shipments 응답: 운송장 + 바뀐 단말기 */
export interface CreatedShipmentView extends ShipmentView {
  terminal: TerminalView;
}
