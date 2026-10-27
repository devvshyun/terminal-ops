/**
 * api의 런타임 enum(MikroORM 엔티티·class-validator가 쓴다)과 @terminal-ops/contracts의 문자열 유니온이 같은 값 집합인지 타입으로 단언한다(decisions/0048).
 * 어느 한쪽에만 값이 있으면 api tsc(build·typecheck)가 이 파일에서 TS2344로 실패하고, 메시지에 빠진 값이 나온다.
 * 응답에 나가는 enum만 단언한다. 응답 본문에 나오지 않는 내부 enum(TargetStatus·VanStatus·CarrierEventCode·OutboxStatus)은 계약에 없고 여기서도 단언하지 않는다.
 * 런타임 코드는 없다(빌드하면 빈 모듈). import하는 곳도 없다 — tsconfig의 include(src)로 검사 대상에 들어간다.
 */
import type * as C from '@terminal-ops/contracts';
import type { AnomalyRule } from '../anomaly/anomaly.entity.js';
import type { Carrier } from '../carrier/carrier.types.js';
import type { RolloutStatus } from '../firmware/firmware.entities.js';
import type { PurchaseOrderStatus } from '../purchase-order/purchase-order.entity.js';
import type { WeeklyReportStatus } from '../report/weekly-report.entity.js';
import type { ScanKind } from '../scan/scan-batch.entity.js';
import type { ServiceTicketStatus } from '../service/service-ticket.entity.js';
import type { ShipmentStatus, SYNC_RUN_OUTCOMES } from '../shipment/shipment.entities.js';
import type { TerminalStatus, TransitionSource } from '../terminal/terminal-status.js';
import type { VanMismatchKind, VanRunStatus, VanRunTrigger } from '../van/van.entities.js';

/** 같은 값 집합이면 true, 아니면 한쪽에만 있는 값을 담은 객체 타입 */
type Same<Api, Contract> = [Api] extends [Contract]
  ? [Contract] extends [Api]
    ? true
    : { onlyInContract: Exclude<Contract, Api> }
  : { onlyInApi: Exclude<Api, Contract> };

/** true만 받는다. 아니면 TS2344 — 메시지에 onlyInApi/onlyInContract와 그 값이 보인다 */
type Assert<T extends true> = T;

export type ContractEnumAssertions = [
  Assert<Same<`${TerminalStatus}`, C.TerminalStatus>>,
  Assert<Same<`${TransitionSource}`, C.TransitionSource>>,
  Assert<Same<`${Carrier}`, C.Carrier>>,
  Assert<Same<`${ShipmentStatus}`, C.ShipmentStatus>>,
  Assert<Same<`${ScanKind}`, C.ScanKind>>,
  Assert<Same<`${PurchaseOrderStatus}`, C.PurchaseOrderStatus>>,
  Assert<Same<`${ServiceTicketStatus}`, C.ServiceTicketStatus>>,
  Assert<Same<`${RolloutStatus}`, C.RolloutStatus>>,
  Assert<Same<`${AnomalyRule}`, C.AnomalyRule>>,
  Assert<Same<`${VanRunStatus}`, C.VanRunStatus>>,
  Assert<Same<`${VanRunTrigger}`, C.VanRunTrigger>>,
  Assert<Same<`${VanMismatchKind}`, C.VanMismatchKind>>,
  Assert<Same<`${WeeklyReportStatus}`, C.WeeklyReportStatus>>,
  Assert<Same<(typeof SYNC_RUN_OUTCOMES)[number], C.SyncRunOutcome>>,
];
