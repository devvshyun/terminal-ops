import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendJson, sleep } from './http.js';
import { VAN_STATUSES, type PartnersState, type VanRegistration, type VanStatus } from './state.js';

/** 목록 기본 페이지 크기 */
export const BRIDGEVAN_DEFAULT_LIMIT = 100;

const isStatus = (v: unknown): v is VanStatus => typeof v === 'string' && (VAN_STATUSES as readonly string[]).includes(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** 커서는 "마지막으로 준 tid"를 base64url로 감싼 것. 클라이언트는 내용을 몰라도 된다(불투명) */
export function encodeCursor(tid: string): string {
  return Buffer.from(tid, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string | null {
  const tid = Buffer.from(cursor, 'base64url').toString('utf8');
  return tid.length > 0 && encodeCursor(tid) === cursor ? tid : null;
}

/** 정렬된 tid 목록에서 tid보다 큰 첫 위치(이진 탐색) */
function upperBound(tids: string[], tid: string): number {
  let lo = 0;
  let hi = tids.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (tids[mid] <= tid) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function view(r: VanRegistration) {
  return { tid: r.tid, serialNo: r.serialNo, merchantCode: r.merchantCode, status: r.status, registeredAt: r.registeredAt, updatedAt: r.updatedAt };
}

/** 429·503·지연(목록·단건 공통 골칫거리). 응답을 보냈으면 true */
async function trouble(state: PartnersState, res: ServerResponse): Promise<boolean> {
  const cfg = state.config.bridgevan;
  if (state.chance(cfg.force429Rate)) {
    state.stats.status429 += 1;
    state.stats.status429Forced += 1;
    sendJson(res, 429, { error: 'RATE_LIMITED' }, { 'Retry-After': String(cfg.retryAfterSec) });
    return true;
  }
  if (state.chance(cfg.error5xxRate)) {
    state.stats.status5xx += 1;
    sendJson(res, 503, { error: 'TEMPORARY_UNAVAILABLE' });
    return true;
  }
  if (cfg.delayMs > 0) await sleep(cfg.delayMs);
  return false;
}

/**
 * 스캔 도중 변경: 이미 지나간 등록(tids[0..passed)) 중 서로 다른 n건을 시드 난수로 골라 바꾼다.
 * healTo가 있으면 그 값으로(어긋남이 풀림, 한 번만), 없으면 ACTIVE↔SUSPENDED를 뒤집는다(CANCELLED는 그대로).
 */
function mutatePassed(state: PartnersState, passed: number): void {
  const n = state.config.bridgevan.mutateDuringScan;
  if (n <= 0 || passed <= 0) return;
  const now = new Date().toISOString();
  // 한 요청 안에서는 서로 다른 등록을 고른다(같은 등록을 두 번 고르면 고친 값을 다시 뒤집는다)
  const picked = new Set<number>();
  while (picked.size < Math.min(n, passed)) picked.add(Math.floor(state.rng() * passed));
  for (const index of picked) {
    const r = state.van.get(state.vanTids[index])!;
    if (r.healTo) {
      if (r.healTo.status) r.status = r.healTo.status;
      if (r.healTo.merchantCode) r.merchantCode = r.healTo.merchantCode;
      delete r.healTo;
      state.stats.vanHealed += 1;
    } else if (r.status === 'ACTIVE' || r.status === 'SUSPENDED') {
      r.status = r.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    } else {
      continue;
    }
    r.updatedAt = now;
    state.stats.vanMutated += 1;
  }
}

/**
 * GET /bridgevan/v1/terminals?cursor=&limit=  → { items, nextCursor }
 * 커서(키셋) 페이지: tid 오름차순, 커서 = 앞 페이지 마지막 tid. offset이 아니므로 페이지를 넘기는 사이 앞쪽에 등록이 생기거나
 * 지워져도 다음 페이지가 밀리거나 당겨지지 않는다(중복·누락 없음, decisions/0033). 마지막 페이지면 nextCursor null.
 * GET /bridgevan/v1/terminals?serialNo=  → { items: [0~1건], nextCursor: null } (재검증용 시리얼 조회, 스캔 도중 변경 없음)
 */
export async function bridgevanList(state: PartnersState, url: URL, res: ServerResponse): Promise<void> {
  state.count('bridgevan.list');
  const serialNo = url.searchParams.get('serialNo');
  const cursor = url.searchParams.get('cursor');
  const limitText = url.searchParams.get('limit');
  const limit = limitText === null ? BRIDGEVAN_DEFAULT_LIMIT : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > state.config.bridgevan.maxLimit) {
    return sendJson(res, 400, { error: 'BAD_REQUEST', message: `limit은 1~${state.config.bridgevan.maxLimit}입니다.` });
  }
  const after = cursor ? decodeCursor(cursor) : null;
  if (cursor && after === null) return sendJson(res, 400, { error: 'INVALID_CURSOR' });
  if (await trouble(state, res)) return;

  if (serialNo !== null) {
    const tid = state.vanBySerial.get(serialNo);
    return sendJson(res, 200, { items: tid ? [view(state.van.get(tid)!)] : [], nextCursor: null });
  }
  const start = after === null ? 0 : upperBound(state.vanTids, after);
  // 골칫거리: 둘째 페이지부터, 이미 지나간 등록이 바뀐다(첫 페이지에서 본 값이 낡는다)
  if (after !== null) mutatePassed(state, start);
  const page = state.vanTids.slice(start, start + limit).map((tid) => view(state.van.get(tid)!));
  const more = start + limit < state.vanTids.length;
  sendJson(res, 200, { items: page, nextCursor: more && page.length > 0 ? encodeCursor(page.at(-1)!.tid) : null });
}

/** GET /bridgevan/v1/terminals/:tid → 등록 한 건, 없으면 404 */
export async function bridgevanGet(state: PartnersState, tid: string, res: ServerResponse): Promise<void> {
  state.count('bridgevan.get');
  if (await trouble(state, res)) return;
  const r = state.van.get(tid);
  if (!r) return sendJson(res, 404, { error: 'NOT_FOUND' });
  sendJson(res, 200, view(r));
}

/**
 * POST /__admin/bridgevan/registrations  { registrations: [{ tid, serialNo, merchantCode, status, registeredAt?, healTo? }], replace? }
 * 테스트·실험이 VAN 쪽 등록을 심는다. replace(기본 true)면 기존 등록을 모두 지우고 넣는다. tid·serialNo는 각각 겹치면 안 된다.
 */
export async function bridgevanSeed(state: PartnersState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const list = body?.registrations;
  if (!Array.isArray(list)) return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'registrations 배열이 필요합니다.' });
  const now = new Date().toISOString();
  const incoming: VanRegistration[] = [];
  for (const [i, raw] of list.entries()) {
    const r = raw as Record<string, unknown>;
    const heal = r.healTo as Record<string, unknown> | undefined;
    if (
      !nonEmpty(r.tid) ||
      !nonEmpty(r.serialNo) ||
      !nonEmpty(r.merchantCode) ||
      !isStatus(r.status) ||
      (heal !== undefined && (typeof heal !== 'object' || (heal.status !== undefined && !isStatus(heal.status))))
    ) {
      return sendJson(res, 400, { error: 'BAD_REQUEST', message: `registrations[${i}]: tid, serialNo, merchantCode, status(${VAN_STATUSES.join('|')})가 필요합니다.` });
    }
    const registeredAt = typeof r.registeredAt === 'string' ? r.registeredAt : now;
    incoming.push({
      tid: r.tid,
      serialNo: r.serialNo,
      merchantCode: r.merchantCode,
      status: r.status,
      registeredAt,
      updatedAt: registeredAt,
      ...(heal ? { healTo: { status: heal.status as VanStatus | undefined, merchantCode: heal.merchantCode as string | undefined } } : {}),
    });
  }
  // 새 맵에 다 넣어 보고 겹침이 없을 때만 바꾼다(400이면 기존 등록 그대로)
  const keep = body?.replace === false;
  const van = new Map(keep ? state.van : []);
  const bySerial = new Map(keep ? state.vanBySerial : []);
  for (const r of incoming) {
    const other = bySerial.get(r.serialNo);
    if ((other !== undefined && other !== r.tid) || (van.has(r.tid) && van.get(r.tid)!.serialNo !== r.serialNo)) {
      return sendJson(res, 400, { error: 'DUPLICATE', message: `tid ${r.tid} / serialNo ${r.serialNo}가 다른 등록과 겹칩니다.` });
    }
    van.set(r.tid, r);
    bySerial.set(r.serialNo, r.tid);
  }
  state.van = van;
  state.vanBySerial = bySerial;
  state.vanTids = [...state.van.keys()].sort();
  sendJson(res, 200, { count: state.van.size });
}
