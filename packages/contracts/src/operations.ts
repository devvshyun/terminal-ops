import type { RowResult } from './common.js';
import type { PurchaseOrderStatus, RolloutStatus, RowResultCode, ScanKind, ServiceTicketStatus, TerminalStatus } from './statuses.js';

/** 박스 스캔 결과(POST /scans 201 새로 처리 · 200 replayed, GET /scans/:scanId, decisions/0020) */
export interface ScanView {
  scanId: string;
  kind: ScanKind;
  poNo: string | null;
  actor: string;
  /** 같은 scanId로 다시 보내 저장된 결과를 돌려줬으면 true */
  replayed: boolean;
  createdAt: string;
  /** 결과 코드별 행 수(0인 코드는 빠진다) */
  summary: Partial<Record<RowResultCode, number>>;
  /** 요청의 시리얼 순서 그대로 */
  results: RowResult[];
}

/** 발주(api toPurchaseOrderView) */
export interface PurchaseOrderView {
  id: number;
  poNo: string;
  modelCode: string;
  quantity: number;
  status: PurchaseOrderStatus;
  orderedBy: string;
  createdAt: string;
  closedAt: string | null;
  closedBy: string | null;
}

/** GET /purchase-orders/:poNo/reconciliation — 발주 대비 입고 대조(F10) */
export interface PurchaseOrderReconciliation {
  poNo: string;
  modelCode: string;
  status: PurchaseOrderStatus;
  ordered: number;
  /** 납품 명세의 시리얼 수 */
  noted: number;
  received: number;
  /** ordered − noted */
  shortfall: number;
  /** 명세에는 있는데 입고되지 않은 시리얼 */
  missing: string[];
  /** 입고 스캔에서 명세 밖이라 거절된 시리얼 */
  unexpected: string[];
}

/** POST /purchase-orders/:poNo/close 응답: 마감 뒤 대조 */
export interface ClosedPurchaseOrder extends PurchaseOrderReconciliation {
  closedAt: string | null;
  closedBy: string | null;
}

/** A/S 접수(api toTicketView) */
export interface TicketView {
  id: number;
  serialNo: string;
  merchantCode: string;
  symptom: string;
  status: ServiceTicketStatus;
  remoteNote: string | null;
  replacementSerialNo: string | null;
  outboundShipmentId: number | null;
  outboundTrackingNo: string | null;
  openedBy: string;
  createdAt: string;
  closedAt: string | null;
}

/**
 * 가맹점주가 보는 A/S 접수(api toMerchantTicketView, `/me/service-tickets` — decisions/0053).
 * 직원 로그인 아이디(`openedBy`)와 본사 내부 원격 점검 메모(`remoteNote`)는 주지 않는다.
 * `openedByMe`: 로그인한 가맹점주 본인이 접수했나(false = 본사 직원 또는 같은 가맹점의 다른 계정).
 */
export interface MerchantTicketView extends Omit<TicketView, 'openedBy' | 'remoteNote'> {
  openedByMe: boolean;
  /** 본사가 원격 점검을 했나(메모 내용은 주지 않는다 — 진행 단계 표시용, 보강 3 decisions/0059) */
  remoteChecked: boolean;
  /** 교체 단말기의 지금 상태(SHIPPED 배송 중 → DELIVERED 설치 확인 대기 → IN_SERVICE). 교체 전이면 null */
  replacementStatus: TerminalStatus | null;
}

/** 펌웨어(api toFirmwareView, POST /firmware) */
export interface FirmwareView {
  id: number;
  modelCode: string;
  version: string;
  createdBy: string;
  createdAt: string;
}

/** 배포 단계 하나의 대상·결과 수 */
export interface StageStats {
  stage: number;
  /** 이 단계까지의 누적 비율(%) */
  percent: number;
  targets: number;
  offered: number;
  succeeded: number;
  failed: number;
  timedOut: number;
}

/** 펌웨어 단계 배포(api toRolloutView) */
export interface RolloutView {
  id: number;
  modelCode: string;
  version: string;
  status: RolloutStatus;
  /** 단계별 누적 비율(%), 예 [10, 50, 100] */
  stages: number[];
  /** 지금 단계(stages의 위치, 0부터) */
  currentStage: number;
  failureThreshold: number;
  minSamples: number;
  stageTimeoutMs: number;
  stageStartedAt: string;
  createdBy: string;
  createdAt: string;
  finishedAt: string | null;
  endReason: string | null;
  stageStats: StageStats[];
}
