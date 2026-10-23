import { partnerFetch } from '../common/partner-http.js';
import { PartnerPermanentError } from '../common/partner-errors.js';

export interface SeumOptions {
  baseUrl: string;
  timeoutMs: number;
}

export interface DeliveryNote {
  poNo: string;
  serials: string[];
}

function parseObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PartnerPermanentError('세움전자 응답이 JSON 객체가 아닙니다.');
  }
  return value as Record<string, unknown>;
}

/** 세움전자(가상 공장) API. 오류 분류는 택배사와 같은 partnerFetch를 쓴다(decisions/0010). */
export class SeumClient {
  constructor(private readonly opts: SeumOptions) {}

  /** 발주하고 공장이 정한 발주번호를 돌려준다. */
  async createPurchaseOrder(input: { modelCode: string; quantity: number; reference: string }): Promise<string> {
    const body = parseObject(
      await partnerFetch(
        '세움전자 발주',
        `${this.opts.baseUrl}/seum/v1/purchase-orders`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
        this.opts.timeoutMs,
      ),
    );
    if (typeof body.poNo !== 'string' || !body.poNo) throw new PartnerPermanentError('세움전자 발주 응답에 poNo가 없습니다.');
    return body.poNo;
  }

  /** 납품 명세(공장이 보낸다고 한 시리얼 목록) */
  async getDeliveryNote(poNo: string): Promise<DeliveryNote> {
    const body = parseObject(
      await partnerFetch(
        '세움전자 납품 명세',
        `${this.opts.baseUrl}/seum/v1/purchase-orders/${encodeURIComponent(poNo)}/delivery-note`,
        { method: 'GET' },
        this.opts.timeoutMs,
      ),
    );
    const serials = body.serials;
    if (!Array.isArray(serials) || !serials.every((s) => typeof s === 'string')) {
      throw new PartnerPermanentError('세움전자 납품 명세에 serials 배열이 없습니다.');
    }
    return { poNo, serials };
  }
}
