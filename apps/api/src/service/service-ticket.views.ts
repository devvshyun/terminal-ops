import type { TicketView } from '@terminal-ops/contracts';
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
