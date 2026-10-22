import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { bungaeCreateWaybill, bungaeTrack } from './bungae.js';
import { readJson, sendJson } from './http.js';
import { PartnersState, type ConfigPatch } from './state.js';

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

  // 번개택배(JSON)
  if (method === 'POST' && path === '/bungae/v1/waybills') return bungaeCreateWaybill(state, req, res);
  if (method === 'GET' && (m = path.match(/^\/bungae\/v1\/trackings\/([^/]+)$/))) {
    return bungaeTrack(state, decodeURIComponent(m[1]), res);
  }

  sendJson(res, 404, { error: 'NO_ROUTE', method, path });
}

/** 가상 업체 서버. 상태는 메모리에만 있다. */
export function createPartnersServer(state = new PartnersState()): { server: Server; state: PartnersState } {
  const server = createServer((req, res) => {
    route(state, req, res).catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL', message: String(error) });
      else res.end();
    });
  });
  return { server, state };
}
