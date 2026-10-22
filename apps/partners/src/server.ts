import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { bungaeCreateWaybill, bungaeTrack } from './bungae.js';
import { BadJsonError, readJson, sendJson } from './http.js';
import { neurimboCreateInvoice, neurimboTrack } from './neurimbo.js';
import { PartnersState, type ConfigPatch } from './state.js';
import { toktokHook, toktokSummary } from './toktok.js';

async function route(state: PartnersState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://partners');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  let m: RegExpMatchArray | null;

  // 관리 API: 테스트·실험이 설정을 바꾸고 결과를 센다.
  if (method === 'GET' && path === '/__admin/health') return sendJson(res, 200, { status: 'ok' });
  if (method === 'POST' && path === '/__admin/reset') {
    state.reset();
    return sendJson(res, 200, state.config);
  }
  if (method === 'POST' && path === '/__admin/config') {
    const patch = (await readJson(req)) as ConfigPatch | undefined;
    return sendJson(res, 200, state.configure(patch ?? {}));
  }
  if (method === 'GET' && path === '/__admin/stats') return sendJson(res, 200, state.stats);
  if (method === 'GET' && path === '/__admin/toktok/messages') return sendJson(res, 200, toktokSummary(state));

  // 번개택배(JSON)
  if (method === 'POST' && path === '/bungae/v1/waybills') return bungaeCreateWaybill(state, req, res);
  if (method === 'GET' && (m = path.match(/^\/bungae\/v1\/trackings\/([^/]+)$/))) {
    return bungaeTrack(state, decodeURIComponent(m[1]), res);
  }

  // 느림보물류(XML)
  if (method === 'POST' && path === '/neurimbo/api/invoice') return neurimboCreateInvoice(state, req, res);
  if (method === 'GET' && path === '/neurimbo/api/track') return neurimboTrack(state, url.searchParams.get('invoiceNo') ?? '', res);

  // 톡톡메신저 웹훅
  if (method === 'POST' && (m = path.match(/^\/toktok\/hooks\/([^/]+)$/))) {
    return toktokHook(state, decodeURIComponent(m[1]), req, res);
  }

  sendJson(res, 404, { error: 'NO_ROUTE', method, path });
}

/** 가상 업체 서버. 상태는 메모리에만 있다. */
export function createPartnersServer(state = new PartnersState()): { server: Server; state: PartnersState } {
  const server = createServer((req, res) => {
    route(state, req, res).catch((error: unknown) => {
      if (error instanceof BadJsonError && !res.headersSent) return sendJson(res, 400, { error: 'BAD_REQUEST', message: error.message });
      if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL', message: String(error) });
      else res.end();
    });
  });
  return { server, state };
}
