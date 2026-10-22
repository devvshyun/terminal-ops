import { partnerFetch } from '../common/partner-http.js';
import { PartnerPermanentError } from '../common/partner-errors.js';
import { parseBungaeTracking, parseBungaeWaybill } from './bungae.parser.js';
import { Carrier, type CarrierAdapter, type NormalizedEvent, type WaybillInput } from './carrier.types.js';
import { buildNeurimboInvoiceRequest, parseNeurimboInvoice, parseNeurimboTrace } from './neurimbo.parser.js';

export interface AdapterOptions {
  baseUrl: string;
  timeoutMs: number;
}

function parseJson(label: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PartnerPermanentError(`${label} 응답이 JSON이 아닙니다.`);
  }
}

/** 번개택배: JSON API */
export class BungaeAdapter implements CarrierAdapter {
  readonly carrier = Carrier.BUNGAE;
  constructor(private readonly opts: AdapterOptions) {}

  async createWaybill(input: WaybillInput): Promise<string> {
    const text = await partnerFetch(
      '번개택배 운송장 발급',
      `${this.opts.baseUrl}/bungae/v1/waybills`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
      this.opts.timeoutMs,
    );
    return parseBungaeWaybill(parseJson('번개택배', text));
  }

  async track(trackingNo: string): Promise<NormalizedEvent[]> {
    const text = await partnerFetch(
      '번개택배 추적',
      `${this.opts.baseUrl}/bungae/v1/trackings/${encodeURIComponent(trackingNo)}`,
      { method: 'GET' },
      this.opts.timeoutMs,
    );
    return parseBungaeTracking(parseJson('번개택배', text));
  }
}

/** 느림보물류: XML API, 상태 코드 체계가 다르다 */
export class NeurimboAdapter implements CarrierAdapter {
  readonly carrier = Carrier.NEURIMBO;
  constructor(private readonly opts: AdapterOptions) {}

  async createWaybill(input: WaybillInput): Promise<string> {
    const text = await partnerFetch(
      '느림보물류 송장 발급',
      `${this.opts.baseUrl}/neurimbo/api/invoice`,
      { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: buildNeurimboInvoiceRequest(input) },
      this.opts.timeoutMs,
    );
    return parseNeurimboInvoice(text);
  }

  async track(trackingNo: string): Promise<NormalizedEvent[]> {
    const text = await partnerFetch(
      '느림보물류 추적',
      `${this.opts.baseUrl}/neurimbo/api/track?invoiceNo=${encodeURIComponent(trackingNo)}`,
      { method: 'GET' },
      this.opts.timeoutMs,
    );
    return parseNeurimboTrace(text);
  }
}

/** 택배사 → 어댑터. 서비스는 택배사를 몰라도 여기서 꺼내 쓴다. */
export class CarrierAdapters {
  private readonly byCarrier: Map<Carrier, CarrierAdapter>;

  constructor(adapters: CarrierAdapter[]) {
    this.byCarrier = new Map(adapters.map((a) => [a.carrier, a]));
  }

  get(carrier: Carrier): CarrierAdapter {
    const adapter = this.byCarrier.get(carrier);
    if (!adapter) throw new Error(`택배사 ${carrier} 어댑터가 없습니다.`);
    return adapter;
  }
}
