import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendJson, sleep } from './http.js';
import type { PartnersState } from './state.js';

/** 번개택배 상태 코드. 조회할 때마다 앞에서부터 한 단계씩 드러난다. */
export const BUNGAE_CODES = ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'] as const;

/** POST /bungae/v1/waybills  { receiverName, address, reference } → 201 { trackingNo } */
export async function bungaeCreateWaybill(state: PartnersState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  state.count('bungae.waybill');
  const body = await readJson(req);
  if (!body || typeof body.reference !== 'string' || !body.reference) {
    return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'reference가 필요합니다.' });
  }
  const trackingNo = `BG${state.nextNumber()}`;
  state.bungae.set(trackingNo, { createdAt: Date.now(), polls: 0 });
  sendJson(res, 201, { trackingNo });
}

/** GET /bungae/v1/trackings/:trackingNo → { trackingNo, events: [{ eventId, code, occurredAt }] } */
export async function bungaeTrack(state: PartnersState, trackingNo: string, res: ServerResponse): Promise<void> {
  const cfg = state.config.bungae;
  state.count('bungae.track', trackingNo);

  const now = Date.now();
  state.bungaeWindow = state.bungaeWindow.filter((t) => now - t < 1000);
  // 한도 초과를 먼저 본다. 한도 안일 때만 강제 429 난수를 뽑는다(원래 순서 그대로 — 난수 순서를 바꾸지 않는다).
  const overLimit = state.bungaeWindow.length >= cfg.rateLimitPerSec;
  if (overLimit || state.chance(cfg.force429Rate)) {
    state.stats.status429 += 1;
    if (overLimit) state.stats.status429Limit += 1;
    else state.stats.status429Forced += 1;
    return sendJson(res, 429, { error: 'RATE_LIMITED' }, { 'Retry-After': String(cfg.retryAfterSec) });
  }
  state.bungaeWindow.push(now);

  const parcel = state.bungae.get(trackingNo);
  if (!parcel) return sendJson(res, 404, { error: 'NOT_FOUND' });

  state.begin(trackingNo);
  try {
    if (cfg.delayMs > 0) await sleep(cfg.delayMs);
    parcel.polls += 1;
    const stage = Math.min(parcel.polls * cfg.advancePerPoll, BUNGAE_CODES.length);
    const events: { eventId: string; code: string; occurredAt: string }[] = [];
    for (let i = 0; i < stage; i++) {
      const event = {
        eventId: `${trackingNo}-${i + 1}`,
        code: BUNGAE_CODES[i],
        occurredAt: new Date(parcel.createdAt + (i + 1) * 60_000).toISOString(),
      };
      events.push(event);
      // 골칫거리: 같은 이벤트를 한 번 더 보낸다.
      if (state.chance(cfg.duplicateRate)) events.push({ ...event });
    }
    sendJson(res, 200, { trackingNo, events });
  } finally {
    state.end(trackingNo);
  }
}
