import { PartnerPermanentError } from '../common/partner-errors.js';
import { CarrierEventCode, type NormalizedEvent } from './carrier.types.js';

const CODES = new Set<string>(Object.values(CarrierEventCode));

function fail(detail: string): never {
  throw new PartnerPermanentError(`번개택배 응답 형식 오류: ${detail}`);
}

/** 번개택배 운송장 발급 응답 { trackingNo } */
export function parseBungaeWaybill(body: unknown): string {
  const trackingNo = (body as { trackingNo?: unknown } | null)?.trackingNo;
  if (typeof trackingNo !== 'string' || !trackingNo) fail('trackingNo 없음');
  return trackingNo;
}

/**
 * 번개택배 추적 응답 { trackingNo, events: [{ eventId, code, occurredAt }] }.
 * 번개는 같은 이벤트를 두 번 보내기도 한다. 여기서는 걸러내지 않고 그대로 돌려준다(중복 처리는 적재 단계의 몫).
 */
export function parseBungaeTracking(body: unknown): NormalizedEvent[] {
  const events = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) fail('events 배열 없음');
  return events
    .map((item: unknown) => {
      if (typeof item !== 'object' || item === null) fail('events 항목이 객체가 아님');
      const e = item as Record<string, unknown>;
      if (typeof e.eventId !== 'string' || !e.eventId) fail('eventId 없음');
      if (typeof e.code !== 'string' || !CODES.has(e.code)) fail(`알 수 없는 상태 코드 ${String(e.code)}`);
      const occurredAt = new Date(String(e.occurredAt));
      if (Number.isNaN(occurredAt.getTime())) fail(`시각 형식 ${String(e.occurredAt)}`);
      return { eventKey: e.eventId, code: e.code as CarrierEventCode, occurredAt, raw: e };
    })
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}
