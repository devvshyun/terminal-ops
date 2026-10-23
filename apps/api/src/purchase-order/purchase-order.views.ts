import type { PurchaseOrder } from './purchase-order.entity.js';

/** model이 populate돼 있어야 한다. */
export function toPurchaseOrderView(po: PurchaseOrder) {
  return {
    poNo: po.poNo,
    modelCode: po.model.code,
    quantity: po.quantity,
    status: po.status,
    orderedBy: po.orderedBy,
    createdAt: po.createdAt.toISOString(),
    closedAt: po.closedAt?.toISOString() ?? null,
  };
}
