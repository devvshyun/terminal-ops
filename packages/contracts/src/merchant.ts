/**
 * 가맹점주(점주) 화면이 받는 단말기 모양(보강 3, `apps/merchant`, `/me/terminals` — decisions/0059).
 * 운영자용 TerminalView·ShipmentView·HistoryView를 그대로 주지 않고 필드를 골라 준다 — version(낙관적 락)·이력의 actor·reason·
 * 접속 정보의 출처(redis·snapshot)처럼 점주에게 필요 없거나 내부 사정인 값은 없다. 화면 이름(한글)은 매장 앱 `lib/labels.ts`.
 */
import type { OffsetPage } from './common.js';
import type { Carrier, CarrierEventCode, ShipmentStatus, TerminalStatus } from './statuses.js';

/** 접속 요약(운영 중 단말기만) */
export interface MerchantConnectivity {
  online: boolean;
  /** 마지막 하트비트 시각. 한 번도 받지 못했으면 null */
  lastSeenAt: string | null;
  firmwareVersion: string | null;
}

/** 오고 있는(또는 막 도착한) 단말기의 운송장과 택배 단계 */
export interface MerchantShipmentView {
  carrier: Carrier;
  trackingNo: string;
  status: ShipmentStatus;
  createdAt: string;
  deliveredAt: string | null;
  /** A/S 교체로 보낸 것이면 그 접수 번호, 아니면 null */
  ticketId: number | null;
  /** 택배사 이벤트(오래된 것부터) */
  events: { code: CarrierEventCode; occurredAt: string }[];
}

/** GET /me/terminals 한 줄 */
export interface MerchantTerminalView {
  serialNo: string;
  modelCode: string;
  modelName: string;
  status: TerminalStatus;
  /** 지금 상태가 된 시각 */
  statusChangedAt: string;
  /** 운영 중(IN_SERVICE)일 때만, 아니면 null */
  connectivity: MerchantConnectivity | null;
  /** 배송 중(SHIPPED)·배송 완료(DELIVERED, 설치 전)일 때만 — 이번 배정의 운송장. 아니면 null */
  shipment: MerchantShipmentView | null;
}

/** GET /me/terminals */
export type MerchantTerminalPage = OffsetPage<MerchantTerminalView>;

/** 이 가맹점에 배정된 뒤의 상태 변화 하나(누가·왜는 주지 않는다) */
export interface MerchantTerminalEvent {
  status: TerminalStatus;
  occurredAt: string;
}

/** GET /me/terminals/:serialNo */
export interface MerchantTerminalDetail extends MerchantTerminalView {
  /** 이번 배정(마지막 ALLOCATED)부터의 상태 변화, 오래된 것부터 */
  events: MerchantTerminalEvent[];
}
