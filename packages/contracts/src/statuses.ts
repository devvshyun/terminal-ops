/**
 * 상태·종류 값 목록(문자열 유니온). api의 런타임 enum(MikroORM 엔티티가 쓴다)과 같아야 한다 —
 * api `src/common/contract-assertions.ts`가 양방향으로 같은지 타입으로 단언한다(어긋나면 api tsc 실패, decisions/0048).
 * 화면 이름(한글)은 여기 두지 않는다(어드민 lib/labels.ts, 서버가 이름을 주는 것은 응답의 label 필드).
 */

/** 단말기 상태(api terminal/terminal-status.ts TerminalStatus) */
export type TerminalStatus =
  | 'RECEIVED'
  | 'INSPECTED'
  | 'DEFECTIVE'
  | 'IN_STOCK'
  | 'ALLOCATED'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'IN_SERVICE'
  | 'RETURN_REQUESTED'
  | 'RETURNING'
  | 'RETURNED'
  | 'DISPOSED';

/** 상태를 바꾼 경로(api TransitionSource, decisions/0007) */
export type TransitionSource = 'MANUAL' | 'INSPECTION' | 'BATCH' | 'ALLOCATION' | 'SHIPMENT' | 'SCAN' | 'IMPORT' | 'SERVICE';

/** 택배사(api carrier/carrier.types.ts Carrier) */
export type Carrier = 'BUNGAE' | 'NEURIMBO';

/** 택배사 배송 이벤트(api carrier/carrier.types.ts CarrierEventCode). 가맹점주 화면의 배송 단계로 나간다(보강 3, decisions/0059) */
export type CarrierEventCode = 'PICKED_UP' | 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED';

/** 운송장 상태(api ShipmentStatus) */
export type ShipmentStatus = 'IN_TRANSIT' | 'DELIVERED' | 'SUPERSEDED';

/** 박스 스캔 종류(api ScanKind) */
export type ScanKind = 'RECEIVE' | 'RETURN_IN';

/**
 * 일괄 처리(박스 스캔·엑셀 등록)의 행별 결과 코드(decisions/0019). api는 이 타입을 그대로 쓴다(terminal/bulk-rows.ts).
 * 성공: CREATED, RETURNED. 나머지는 그 행을 반영하지 않은 이유.
 */
export type RowResultCode =
  | 'CREATED'
  | 'RETURNED'
  | 'INVALID_FORMAT'
  | 'DUPLICATE_IN_REQUEST'
  | 'UNKNOWN_MODEL'
  | 'ALREADY_EXISTS'
  | 'NOT_IN_DELIVERY_NOTE'
  | 'NOT_FOUND'
  | 'INVALID_STATE';

/** 발주 상태(api PurchaseOrderStatus) */
export type PurchaseOrderStatus = 'ORDERED' | 'RECEIVING' | 'CLOSED';

/** A/S 접수 상태(api ServiceTicketStatus) */
export type ServiceTicketStatus = 'OPEN' | 'RESOLVED_REMOTELY' | 'REPLACING' | 'CLOSED';

/** 펌웨어 배포 상태(api RolloutStatus) */
export type RolloutStatus = 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'ABORTED';

/** 이상 단말기 규칙(api AnomalyRule) */
export type AnomalyRule =
  | 'DELIVERED_NOT_INSTALLED'
  | 'RETURN_STALLED'
  | 'SHIPPED_TOO_LONG'
  | 'ALLOCATED_NO_SHIPMENT'
  | 'IN_SERVICE_NO_MERCHANT'
  | 'OFFLINE_TOO_LONG';

/** VAN 대조 실행 상태·계기(api VanRunStatus, VanRunTrigger) */
export type VanRunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';
export type VanRunTrigger = 'MANUAL' | 'SCHEDULED';

/** VAN 대조 어긋남 종류(api VanMismatchKind, decisions/0033) */
export type VanMismatchKind = 'NOT_REGISTERED' | 'REGISTERED_BUT_NOT_IN_SERVICE' | 'MERCHANT_MISMATCH' | 'SUSPENDED_WHILE_IN_SERVICE';

/** 주간 리포트 상태(api WeeklyReportStatus) */
export type WeeklyReportStatus = 'PENDING' | 'GENERATED' | 'SENT';

/** 택배 수집 실행 결과(api shipment/shipment.entities.ts SYNC_RUN_OUTCOMES) */
export type SyncRunOutcome = 'OK' | 'DELIVERED' | 'NOOP' | 'SKIPPED' | 'ERROR';
