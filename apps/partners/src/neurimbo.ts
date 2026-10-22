import type { IncomingMessage, ServerResponse } from 'node:http';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { readBody, sendXml, sleep } from './http.js';
import type { PartnersState } from './state.js';

/** 느림보물류 상태 코드: 10 집하, 20 이동 중, 30 배송 출발, 40 배송 완료 */
export const NEURIMBO_CODES = ['10', '20', '30', '40'] as const;

const parser = new XMLParser({ parseTagValue: false, ignoreDeclaration: true });
const builder = new XMLBuilder({});

/** 한국 시간(KST, UTC+9)으로 yyyyMMddHHmmss */
export function toKstCompact(ms: number): string {
  const d = new Date(ms + 9 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function errorXml(code: string): string {
  return builder.build({ error: { code } });
}

/** POST /neurimbo/api/invoice  <invoice><receiver/><address/><reference/></invoice> → <invoice><invoiceNo/></invoice> */
export async function neurimboCreateInvoice(state: PartnersState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = state.config.neurimbo;
  state.count('neurimbo.invoice');
  let reference: unknown;
  try {
    reference = parser.parse(await readBody(req))?.invoice?.reference;
  } catch {
    reference = undefined;
  }
  if (typeof reference !== 'string' || !reference) return sendXml(res, 400, errorXml('BAD_REQUEST'));
  // 골칫거리: 발급도 가끔 503.
  if (state.chance(cfg.error5xxRate)) {
    state.stats.status5xx += 1;
    return sendXml(res, 503, errorXml('TEMPORARY_UNAVAILABLE'));
  }
  const invoiceNo = `NR${state.nextNumber()}`;
  state.neurimbo.set(invoiceNo, { createdAt: Date.now(), polls: 0 });
  sendXml(res, 200, builder.build({ invoice: { invoiceNo } }));
}

/** GET /neurimbo/api/track?invoiceNo= → <trace><invoiceNo/><item><seq/><statusCd/><statusTime/></item>…</trace> */
export async function neurimboTrack(state: PartnersState, invoiceNo: string, res: ServerResponse): Promise<void> {
  const cfg = state.config.neurimbo;
  state.count('neurimbo.track', invoiceNo);
  state.begin(invoiceNo);
  try {
    // 골칫거리: 느리다.
    if (cfg.delayMs > 0) await sleep(cfg.delayMs);
    // 골칫거리: 가끔 503.
    if (state.chance(cfg.error5xxRate)) {
      state.stats.status5xx += 1;
      return sendXml(res, 503, errorXml('TEMPORARY_UNAVAILABLE'));
    }
    const parcel = state.neurimbo.get(invoiceNo);
    if (!parcel) return sendXml(res, 404, errorXml('NOT_FOUND'));

    parcel.polls += 1;
    const stage = Math.min(parcel.polls * cfg.advancePerPoll, NEURIMBO_CODES.length);
    const items = Array.from({ length: stage }, (_, i) => ({
      seq: i + 1,
      statusCd: NEURIMBO_CODES[i],
      statusTime: toKstCompact(parcel.createdAt + (i + 1) * 60_000),
    }));
    // 골칫거리: 순서가 뒤섞여 온다(Fisher-Yates, 시드 난수).
    if (cfg.shuffle) {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(state.rng() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
    }
    sendXml(res, 200, builder.build({ trace: { invoiceNo, item: items } }));
  } finally {
    state.end(invoiceNo);
  }
}
