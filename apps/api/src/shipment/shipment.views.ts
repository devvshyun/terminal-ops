import type { CarrierEvent, Shipment } from './shipment.entities.js';

/** terminal이 populate돼 있어야 한다. */
export function toShipmentView(s: Shipment, events?: CarrierEvent[]) {
  return {
    id: s.id,
    serialNo: s.terminal.serialNo,
    carrier: s.carrier,
    trackingNo: s.trackingNo,
    status: s.status,
    lastSyncedAt: s.lastSyncedAt?.toISOString() ?? null,
    deliveredAt: s.deliveredAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    ...(events
      ? { events: events.map((e) => ({ eventKey: e.eventKey, code: e.code, occurredAt: e.occurredAt.toISOString() })) }
      : {}),
  };
}
