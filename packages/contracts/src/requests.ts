/**
 * 쓰기 요청 본문. 검증 규칙(길이·형식)은 api의 class-validator DTO에 있고, DTO가 `implements`로 이 모양을 따른다(decisions/0048).
 * 어드민은 보내는 본문에 `satisfies`를 붙인다.
 */
import type { Carrier, ScanKind, TerminalStatus } from './statuses.js';

/** 낙관적 락: 화면에서 본 version(decisions/0004) */
interface Versioned {
  expectedVersion: number;
}

/** POST /terminals/:serialNo/transitions */
export interface TransitionRequest extends Versioned {
  to: TerminalStatus;
  /** 1~200자, 공백만은 안 된다 */
  reason: string;
}

/** POST /terminals/:serialNo/allocations */
export interface AllocateRequest extends Versioned {
  merchantCode: string;
}

/** POST /terminals/:serialNo/allocation-cancellations */
export interface CancelAllocationRequest extends Versioned {
  reason: string;
}

/** POST /shipments */
export interface CreateShipmentRequest extends Versioned {
  serialNo: string;
  carrier: Carrier;
}

/** 검수 항목 하나의 결과 */
export interface InspectionResultInput {
  itemCode: string;
  passed: boolean;
  note?: string;
}

/** POST /terminals/:serialNo/inspections — 모델 체크리스트 항목을 빠짐없이 한 번씩 */
export interface InspectRequest {
  results: InspectionResultInput[];
}

/** POST /terminals — 단말기 한 대 등록(입고 상태로). 엑셀 일괄 등록은 multipart `file`(본문 모양 없음, 응답 TerminalImportView) */
export interface RegisterTerminalRequest {
  /** 대문자·숫자·하이픈 4~32자 */
  serialNo: string;
  modelCode: string;
}

/** POST /firmware — (모델, 버전)이 이미 있으면 409 DUPLICATE */
export interface RegisterFirmwareRequest {
  modelCode: string;
  /** 영문·숫자·점·하이픈 1~20자 */
  version: string;
}

/** POST /firmware-rollouts — 등록된 펌웨어의 단계 배포. 같은 모델에 진행 중(RUNNING·PAUSED) 배포가 있으면 409 ROLLOUT_ALREADY_ACTIVE */
export interface CreateRolloutRequest {
  modelCode: string;
  version: string;
  /** 단계별 누적 비율(%) 1~10개, 커지는 순서, 마지막은 100(어기면 400 INVALID_STAGES) */
  stages: number[];
  /** 0~1. 단계 실패율이 이 값을 넘으면 자동 중단 */
  failureThreshold: number;
  /** 실패율을 판단하기 전에 모을 최소 보고 수(1 이상) */
  minSamples: number;
  /** 단계 안에서 보고를 기다리는 시간(ms, 1~86,400,000). 없으면 10분 */
  stageTimeoutMs?: number;
}

/** POST /purchase-orders */
export interface CreatePurchaseOrderRequest {
  modelCode: string;
  /** 1~5000 */
  quantity: number;
}

/** POST /scans — 박스 하나. scanId는 박스마다 만드는 멱등 키(영문·숫자·_·- 8~64자), RECEIVE면 poNo 필수 */
export interface CreateScanRequest {
  scanId: string;
  kind: ScanKind;
  poNo?: string;
  serials: string[];
}

/** POST /service-tickets */
export interface OpenTicketRequest {
  serialNo: string;
  symptom: string;
}

/** POST /service-tickets/:id/remote-checks */
export interface RemoteCheckRequest {
  resolved: boolean;
  note: string;
}

/** POST /service-tickets/:id/replacements */
export interface ReplaceRequest {
  replacementSerialNo: string;
  carrier: Carrier;
}

/** POST /van-reconciliations(본문 없어도 된다). true면 이 실행만 수집 급감 검사를 건너뛴다(decisions/0033) */
export interface StartVanReconciliationRequest {
  acknowledgeDrop?: boolean;
}

/** POST /reports/weekly — 그 주 월요일(KST) YYYY-MM-DD, 없으면 지난주 */
export interface SendWeeklyReportRequest {
  weekStart?: string;
}
