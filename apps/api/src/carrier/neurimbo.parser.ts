import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { PartnerPermanentError } from '../common/partner-errors.js';
import { CarrierEventCode, type NormalizedEvent, type WaybillInput } from './carrier.types.js';

/** 느림보물류 상태 코드 → 공통 코드 */
const STATUS: Record<string, CarrierEventCode> = {
  '10': CarrierEventCode.PICKED_UP,
  '20': CarrierEventCode.IN_TRANSIT,
  '30': CarrierEventCode.OUT_FOR_DELIVERY,
  '40': CarrierEventCode.DELIVERED,
};

// parseTagValue: false → "0010" 같은 값을 숫자로 바꾸지 않고 문자열 그대로 둔다.
// isArray: item이 하나뿐이어도 배열로 받는다.
const parser = new XMLParser({ parseTagValue: false, ignoreDeclaration: true, isArray: (name) => name === 'item' });
const builder = new XMLBuilder({});

function fail(detail: string): never {
  throw new PartnerPermanentError(`느림보물류 응답 형식 오류: ${detail}`);
}

function parseXml(xml: string): Record<string, unknown> {
  try {
    return parser.parse(xml) as Record<string, unknown>;
  } catch (error) {
    fail(`XML 파싱 실패(${String(error)})`);
  }
}

/** yyyyMMddHHmmss(한국 시간) → Date */
export function parseKstCompact(value: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (!m) fail(`시각 형식 ${value}`);
  const [, y, mo, d, h, mi, s] = m.map(Number);
  // KST = UTC+9. Date.UTC는 시가 음수여도 전날로 넘겨 계산한다.
  return new Date(Date.UTC(y, mo - 1, d, h - 9, mi, s));
}

export function buildNeurimboInvoiceRequest(input: WaybillInput): string {
  return builder.build({ invoice: { receiver: input.receiverName, address: input.address, reference: input.reference } });
}

export function parseNeurimboInvoice(xml: string): string {
  const invoiceNo = (parseXml(xml).invoice as { invoiceNo?: unknown } | undefined)?.invoiceNo;
  if (typeof invoiceNo !== 'string' || !invoiceNo) fail('invoiceNo 없음');
  return invoiceNo;
}

/** <trace><invoiceNo/><item><seq/><statusCd/><statusTime/></item>…</trace>. 순서가 섞여 와도 발생 시각 순으로 정렬한다. */
export function parseNeurimboTrace(xml: string): NormalizedEvent[] {
  const trace = parseXml(xml).trace as { item?: Record<string, unknown>[] } | undefined;
  if (!trace) fail('trace 없음');
  return (trace.item ?? [])
    .map((item) => {
      const seq = item.seq;
      const code = STATUS[String(item.statusCd)];
      if (typeof seq !== 'string' || !seq) fail('seq 없음');
      if (!code) fail(`알 수 없는 상태 코드 ${String(item.statusCd)}`);
      return { eventKey: seq, code, occurredAt: parseKstCompact(String(item.statusTime)), raw: item };
    })
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || Number(a.eventKey) - Number(b.eventKey));
}
