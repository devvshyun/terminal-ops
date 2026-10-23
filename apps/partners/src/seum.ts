import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendJson } from './http.js';
import type { PartnersState } from './state.js';

/** 한 번에 받을 수 있는 발주 수량 상한 */
export const SEUM_MAX_QUANTITY = 5000;

const seq4 = (n: number) => String(n).padStart(4, '0');

/**
 * POST /seum/v1/purchase-orders  { modelCode, quantity, reference } → 201 { poNo, modelCode, quantity }
 * 발주를 받는 순간 납품 명세(보낼 시리얼 목록)를 정해 둔다. 골칫거리:
 * - shortfall: 발주보다 n대 적게 보낸다.
 * - foreignSerials: 다른 발주의 시리얼 n개가 명세에 섞인다(섞이는 자리는 시드 난수).
 */
export async function seumCreatePurchaseOrder(state: PartnersState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = state.config.seum;
  state.count('seum.purchaseOrder');
  const body = await readJson(req);
  const modelCode = body?.modelCode;
  const quantity = body?.quantity;
  const reference = body?.reference;
  if (
    typeof modelCode !== 'string' ||
    !modelCode ||
    typeof reference !== 'string' ||
    !reference ||
    typeof quantity !== 'number' ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > SEUM_MAX_QUANTITY
  ) {
    return sendJson(res, 400, { error: 'BAD_REQUEST', message: `modelCode, reference, quantity(1~${SEUM_MAX_QUANTITY})가 필요합니다.` });
  }
  if (state.chance(cfg.error5xxRate)) {
    state.stats.status5xx += 1;
    return sendJson(res, 503, { error: 'TEMPORARY_UNAVAILABLE' });
  }

  const poNo = `SE${state.nextNumber()}`;
  const count = Math.max(0, quantity - cfg.shortfall);
  const serials = Array.from({ length: count }, (_, i) => `${poNo}-${seq4(i + 1)}`);
  if (cfg.foreignSerials > 0) {
    // 다른 발주(우리가 발주한 적 없는 번호)의 시리얼을 섞는다.
    const otherPoNo = `SE${state.nextNumber()}`;
    for (let k = 1; k <= cfg.foreignSerials; k++) {
      serials.splice(Math.floor(state.rng() * (serials.length + 1)), 0, `${otherPoNo}-${seq4(k)}`);
    }
  }
  state.seum.set(poNo, { poNo, modelCode, quantity, reference, serials });
  sendJson(res, 201, { poNo, modelCode, quantity });
}

/** GET /seum/v1/purchase-orders/:poNo/delivery-note → { poNo, modelCode, quantity, serials } */
export function seumDeliveryNote(state: PartnersState, poNo: string, res: ServerResponse): void {
  state.count('seum.deliveryNote');
  const po = state.seum.get(poNo);
  if (!po) return sendJson(res, 404, { error: 'NOT_FOUND' });
  sendJson(res, 200, { poNo: po.poNo, modelCode: po.modelCode, quantity: po.quantity, serials: po.serials });
}
