import type { MerchantTicketView, TicketView } from '@terminal-ops/contracts';
import type { ServiceTicket } from './service-ticket.entity.js';

/** terminal, merchant, replacementTerminal, outboundShipment가 populate돼 있어야 한다. */
export function toTicketView(t: ServiceTicket): TicketView {
  return {
    id: t.id,
    serialNo: t.terminal.serialNo,
    merchantCode: t.merchant.code,
    symptom: t.symptom,
    status: t.status,
    remoteNote: t.remoteNote,
    replacementSerialNo: t.replacementTerminal?.serialNo ?? null,
    outboundShipmentId: t.outboundShipment?.id ?? null,
    outboundTrackingNo: t.outboundShipment?.trackingNo ?? null,
    openedBy: t.openedBy,
    createdAt: t.createdAt.toISOString(),
    closedAt: t.closedAt?.toISOString() ?? null,
  };
}

/**
 * 가맹점주(`/me`)에게 보내는 접수 — 직원 로그인 아이디·내부 메모를 빼고 "내가 접수했나"만 준다(decisions/0053).
 * 필드를 고르는 것은 여기 한 곳(TicketView에 필드가 늘어도 가맹점주에게 저절로 나가지 않게 하나씩 옮긴다).
 */
export function toMerchantTicketView(t: ServiceTicket, myLoginId: string): MerchantTicketView {
  return {
    id: t.id,
    serialNo: t.terminal.serialNo,
    merchantCode: t.merchant.code,
    symptom: t.symptom,
    status: t.status,
    replacementSerialNo: t.replacementTerminal?.serialNo ?? null,
    outboundShipmentId: t.outboundShipment?.id ?? null,
    outboundTrackingNo: t.outboundShipment?.trackingNo ?? null,
    openedByMe: t.openedBy === myLoginId,
    createdAt: t.createdAt.toISOString(),
    closedAt: t.closedAt?.toISOString() ?? null,
  };
}
