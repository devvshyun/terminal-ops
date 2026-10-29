import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { bridgevanGet, bridgevanList, bridgevanSeed } from './bridgevan.js';
import { bungaeCreateWaybill, bungaeTrack } from './bungae.js';
import { BadJsonError, readJson, sendJson } from './http.js';
import { neurimboCreateInvoice, neurimboTrack } from './neurimbo.js';
import { seumCreatePurchaseOrder, seumDeliveryNote } from './seum.js';
import { MAX_REQUESTS } from './requests.js';
import { PartnersState, type ConfigPatch } from './state.js';
import { toktokFile, toktokHook, toktokSummary, toktokUpload } from './toktok.js';

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
  if (method === 'GET' && path === '/__admin/config') return sendJson(res, 200, state.config);
  if (method === 'GET' && path === '/__admin/requests') {
    // 시연 도구의 최근 요청 표(보강 8). limit 1~200 정수, 기본 50
    const raw = url.searchParams.get('limit');
    const limit = raw === null ? 50 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REQUESTS) return sendJson(res, 400, { error: 'BAD_REQUEST', message: `limit은 1~${MAX_REQUESTS} 정수입니다.` });
    return sendJson(res, 200, { total: state.requests.total, items: state.requests.recent(limit) });
  }
  if (method === 'GET' && path === '/__admin/stats') return sendJson(res, 200, state.stats);
  if (method === 'GET' && path === '/__admin/toktok/messages') return sendJson(res, 200, toktokSummary(state));
  if (method === 'GET' && (m = path.match(/^\/__admin\/toktok\/files\/([^/]+)$/))) return toktokFile(state, decodeURIComponent(m[1]), res);
  if (method === 'POST' && path === '/__admin/bridgevan/registrations') return bridgevanSeed(state, req, res);

  // 번개택배(JSON)
  if (method === 'POST' && path === '/bungae/v1/waybills') return bungaeCreateWaybill(state, req, res);
  if (method === 'GET' && (m = path.match(/^\/bungae\/v1\/trackings\/([^/]+)$/))) {
    return bungaeTrack(state, decodeURIComponent(m[1]), res);
  }

  // 느림보물류(XML)
  if (method === 'POST' && path === '/neurimbo/api/invoice') return neurimboCreateInvoice(state, req, res);
  if (method === 'GET' && path === '/neurimbo/api/track') return neurimboTrack(state, url.searchParams.get('invoiceNo') ?? '', res);

  // 세움전자(공장): 발주, 납품 명세
  if (method === 'POST' && path === '/seum/v1/purchase-orders') return seumCreatePurchaseOrder(state, req, res);
  if (method === 'GET' && (m = path.match(/^\/seum\/v1\/purchase-orders\/([^/]+)\/delivery-note$/))) {
    return seumDeliveryNote(state, decodeURIComponent(m[1]), res);
  }

  // 브릿지VAN: 등록 단말기 목록(커서 페이지)·단건
  if (method === 'GET' && path === '/bridgevan/v1/terminals') return bridgevanList(state, url, res);
  if (method === 'GET' && (m = path.match(/^\/bridgevan\/v1\/terminals\/([^/]+)$/))) {
    return bridgevanGet(state, decodeURIComponent(m[1]), res);
  }

  // 톡톡메신저 웹훅·파일 올리기(메시지 첨부)
  if (method === 'POST' && path === '/toktok/files') return toktokUpload(state, req, res);
  if (method === 'POST' && (m = path.match(/^\/toktok\/hooks\/([^/]+)$/))) {
    return toktokHook(state, decodeURIComponent(m[1]), req, res);
  }

  sendJson(res, 404, { error: 'NO_ROUTE', method, path });
}

/** 업체 요청을 응답이 끝날 때 기록한다(관리 API는 빼고). reset 전에 받은 요청이 reset 뒤에 끝나도 새 기록에 들어간다 — 시연 도구용이라 받아들인다 */
function recordWhenDone(state: PartnersState, req: IncomingMessage, res: ServerResponse): void {
  const path = req.url ?? '/';
  if (path.startsWith('/__admin')) return;
  const started = performance.now();
  res.once('finish', () => {
    const partner = new URL(path, 'http://partners').pathname.split('/')[1] ?? '';
    state.requests.add({ at: new Date().toISOString(), partner, method: req.method ?? 'GET', path, status: res.statusCode, ms: Math.round(performance.now() - started) });
  });
}

/** 가상 업체 서버. 상태는 메모리에만 있다. */
export function createPartnersServer(state = new PartnersState()): { server: Server; state: PartnersState } {
  const server = createServer((req, res) => {
    recordWhenDone(state, req, res);
    route(state, req, res).catch((error: unknown) => {
      if (error instanceof BadJsonError && !res.headersSent) return sendJson(res, 400, { error: 'BAD_REQUEST', message: error.message });
      if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL', message: String(error) });
      else res.end();
    });
  });
  return { server, state };
}
