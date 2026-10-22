import { beforeEach, describe, expect, it } from 'vitest';
import { BungaeAdapter, CarrierAdapters, NeurimboAdapter } from '../src/carrier/carrier.adapters.js';
import { Carrier, CarrierEventCode as C } from '../src/carrier/carrier.types.js';
import { PartnerPermanentError, PartnerRateLimitedError, PartnerTransientError } from '../src/common/partner-errors.js';
import { env } from '../src/config/env.js';
import { partners } from './helpers/partners.js';

const opts = { baseUrl: env.partnersUrl, timeoutMs: 1000 };
const adapters = new CarrierAdapters([new BungaeAdapter(opts), new NeurimboAdapter(opts)]);
const input = { reference: 'T-1', receiverName: '판교분식', address: '경기 성남시 분당구 가상길 303' };

describe('택배사 어댑터 ↔ 가상 업체 서버 (F12)', () => {
  beforeEach(async () => {
    await partners.reset();
  });

  it.each([Carrier.BUNGAE, Carrier.NEURIMBO])('%s: 운송장 발급 후 네 번째 조회에 DELIVERED', async (carrier) => {
    const adapter = adapters.get(carrier);
    const trackingNo = await adapter.createWaybill(input);
    let events = await adapter.track(trackingNo);
    expect(events.map((e) => e.code)).toEqual([C.PICKED_UP]);
    for (let i = 0; i < 3; i++) events = await adapter.track(trackingNo);
    expect(events.map((e) => e.code)).toEqual([C.PICKED_UP, C.IN_TRANSIT, C.OUT_FOR_DELIVERY, C.DELIVERED]);
  });

  it('번개 429 → PartnerRateLimitedError, Retry-After를 ms로', async () => {
    const adapter = adapters.get(Carrier.BUNGAE);
    const trackingNo = await adapter.createWaybill(input);
    await partners.configure({ bungae: { force429Rate: 1, retryAfterSec: 2 } });
    const error = await adapter.track(trackingNo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PartnerRateLimitedError);
    expect((error as PartnerRateLimitedError).retryAfterMs).toBe(2000);
  });

  it('느림보 503 → PartnerTransientError', async () => {
    const adapter = adapters.get(Carrier.NEURIMBO);
    const trackingNo = await adapter.createWaybill(input);
    await partners.configure({ neurimbo: { error5xxRate: 1 } });
    await expect(adapter.track(trackingNo)).rejects.toBeInstanceOf(PartnerTransientError);
  });

  it('응답이 타임아웃보다 늦으면 PartnerTransientError', async () => {
    const slow = new NeurimboAdapter({ baseUrl: env.partnersUrl, timeoutMs: 100 });
    const trackingNo = await slow.createWaybill(input);
    await partners.configure({ neurimbo: { delayMs: 500 } });
    await expect(slow.track(trackingNo)).rejects.toThrow(/TimeoutError/);
  });

  it('없는 운송장(404) → PartnerPermanentError', async () => {
    await expect(adapters.get(Carrier.BUNGAE).track('BG0')).rejects.toBeInstanceOf(PartnerPermanentError);
  });
});
