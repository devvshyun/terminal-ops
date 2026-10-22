import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendJson } from './http.js';
import type { PartnersState } from './state.js';

/** POST /toktok/hooks/:channel  { idempotencyKey, text } → 200. 받은 메시지는 중복이어도 모두 저장한다. */
export async function toktokHook(state: PartnersState, channel: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  state.count('toktok.hook');
  const body = await readJson(req);
  if (!body || typeof body.idempotencyKey !== 'string' || typeof body.text !== 'string') {
    return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'idempotencyKey, text가 필요합니다.' });
  }
  // 골칫거리: 가끔 실패한다. 실패한 요청은 저장하지 않는다(받지 못한 것으로 본다).
  if (state.chance(state.config.toktok.failRate)) {
    state.stats.status5xx += 1;
    return sendJson(res, 500, { error: 'TEMPORARY' });
  }
  state.messages.push({ channel, idempotencyKey: body.idempotencyKey, text: body.text, receivedAt: new Date().toISOString() });
  sendJson(res, 200, { ok: true });
}

/** 멱등키별 수신 횟수. 2 이상이면 같은 알림을 두 번 이상 받은 것이다. */
export function toktokSummary(state: PartnersState) {
  const byKey: Record<string, number> = {};
  for (const m of state.messages) byKey[m.idempotencyKey] = (byKey[m.idempotencyKey] ?? 0) + 1;
  return { total: state.messages.length, byKey, messages: state.messages };
}
