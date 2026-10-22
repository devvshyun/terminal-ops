import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBungaeTracking, parseBungaeWaybill } from '../../src/carrier/bungae.parser.js';
import {
  buildNeurimboInvoiceRequest,
  parseKstCompact,
  parseNeurimboInvoice,
  parseNeurimboTrace,
} from '../../src/carrier/neurimbo.parser.js';
import { CarrierEventCode as C } from '../../src/carrier/carrier.types.js';
import { PartnerPermanentError } from '../../src/common/partner-errors.js';
import { parseRetryAfter } from '../../src/common/partner-http.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

describe('번개택배 파서', () => {
  it('이벤트를 공통 형식으로 바꾸고 시각 순으로 정렬한다. 중복은 그대로 둔다', () => {
    const events = parseBungaeTracking(JSON.parse(fixture('bungae-tracking.json')));
    expect(events.map((e) => [e.eventKey, e.code])).toEqual([
      ['BG17611111111110001-1', C.PICKED_UP],
      ['BG17611111111110001-1', C.PICKED_UP],
      ['BG17611111111110001-2', C.IN_TRANSIT],
    ]);
    expect(events[0].occurredAt.toISOString()).toBe('2026-10-22T01:01:00.000Z');
    expect(events[0].raw).toMatchObject({ eventId: 'BG17611111111110001-1' });
  });

  it('모르는 상태 코드는 영구 오류', () => {
    expect(() => parseBungaeTracking({ events: [{ eventId: 'x', code: 'LOST', occurredAt: '2026-10-22T00:00:00Z' }] })).toThrow(
      PartnerPermanentError,
    );
  });

  it('events가 없으면 영구 오류', () => {
    expect(() => parseBungaeTracking({})).toThrow(PartnerPermanentError);
  });

  it('events 안에 null이나 객체가 아닌 값이 있으면 영구 오류', () => {
    expect(() => parseBungaeTracking({ events: [null] })).toThrow(PartnerPermanentError);
    expect(() => parseBungaeTracking({ events: [1] })).toThrow(PartnerPermanentError);
  });

  it('운송장 발급 응답', () => {
    expect(parseBungaeWaybill({ trackingNo: 'BG1' })).toBe('BG1');
    expect(() => parseBungaeWaybill({})).toThrow(PartnerPermanentError);
  });
});

describe('느림보물류 파서', () => {
  it('KST 시각을 UTC Date로', () => {
    expect(parseKstCompact('20261022100100').toISOString()).toBe('2026-10-22T01:01:00.000Z');
    expect(parseKstCompact('20261022000500').toISOString()).toBe('2026-10-21T15:05:00.000Z');
  });

  it('상태 코드를 공통 코드로, 뒤섞인 순서를 시각 순으로', () => {
    const events = parseNeurimboTrace(fixture('neurimbo-trace.xml'));
    expect(events.map((e) => [e.eventKey, e.code])).toEqual([
      ['1', C.PICKED_UP],
      ['2', C.IN_TRANSIT],
      ['3', C.OUT_FOR_DELIVERY],
      ['4', C.DELIVERED],
    ]);
    expect(events[0].raw).toEqual({ seq: '1', statusCd: '10', statusTime: '20261022100100' });
  });

  it('item이 하나여도 배열로 읽는다', () => {
    const events = parseNeurimboTrace(fixture('neurimbo-trace-single.xml'));
    expect(events).toHaveLength(1);
    expect(events[0].occurredAt.toISOString()).toBe('2026-10-21T15:05:00.000Z');
  });

  it('모르는 상태 코드·깨진 시각은 영구 오류', () => {
    expect(() => parseNeurimboTrace('<trace><item><seq>1</seq><statusCd>99</statusCd><statusTime>20261022100100</statusTime></item></trace>')).toThrow(
      PartnerPermanentError,
    );
    expect(() => parseNeurimboTrace('<trace><item><seq>1</seq><statusCd>10</statusCd><statusTime>2026-10-22</statusTime></item></trace>')).toThrow(
      PartnerPermanentError,
    );
  });

  it('송장 발급 요청·응답 XML', () => {
    expect(buildNeurimboInvoiceRequest({ reference: 'R1', receiverName: '역삼카페', address: '서울' })).toBe(
      '<invoice><receiver>역삼카페</receiver><address>서울</address><reference>R1</reference></invoice>',
    );
    expect(parseNeurimboInvoice('<?xml version="1.0"?><invoice><invoiceNo>NR1</invoiceNo></invoice>')).toBe('NR1');
  });
});

describe('Retry-After', () => {
  it('초 단위와 HTTP 날짜를 ms로, 없으면 1초', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(null)).toBe(1000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 7_000)).toBe(3000);
  });
});
