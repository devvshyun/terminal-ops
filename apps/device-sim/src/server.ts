import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { defaultConfig, invalidReason, type SimConfigPatch } from './config.js';
import { Fleet } from './fleet.js';
import { BadJsonError, readJson, sendJson } from './http.js';

async function route(fleet: Fleet, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://device-sim').pathname;
  const method = req.method ?? 'GET';
  let m: RegExpMatchArray | null;

  if (method === 'GET' && path === '/__admin/health') return sendJson(res, 200, { status: 'ok' });
  if (method === 'GET' && path === '/__admin/config') return sendJson(res, 200, fleet.config);
  if (method === 'POST' && path === '/__admin/config') {
    const patch = ((await readJson(req)) ?? {}) as SimConfigPatch;
    const next = { ...fleet.config, ...patch };
    const reason = invalidReason(next);
    if (reason) return sendJson(res, 400, { error: 'BAD_CONFIG', message: reason });
    // 보내는 중인 주기를 끝낸 뒤 바꾸고, 돌던 중이었으면 새 설정(주기 포함)으로 다시 돈다.
    const wasRunning = fleet.running;
    await fleet.stop();
    fleet.configure(next);
    if (wasRunning) fleet.start();
    return sendJson(res, 200, fleet.config);
  }
  if (method === 'POST' && path === '/__admin/start') {
    fleet.start();
    return sendJson(res, 200, { running: true });
  }
  if (method === 'POST' && path === '/__admin/stop') {
    await fleet.stop();
    return sendJson(res, 200, { running: false });
  }
  if (method === 'POST' && path === '/__admin/reset') {
    await fleet.reset(defaultConfig());
    return sendJson(res, 200, fleet.config);
  }
  if (method === 'GET' && path === '/__admin/stats') return sendJson(res, 200, { running: fleet.running, ...fleet.stats.view() });
  if (method === 'GET' && (m = path.match(/^\/__admin\/devices\/([^/]+)$/))) {
    const device = fleet.devices.get(decodeURIComponent(m[1]));
    return device ? sendJson(res, 200, device) : sendJson(res, 404, { error: 'NO_DEVICE' });
  }
  sendJson(res, 404, { error: 'NO_ROUTE', method, path });
}

/** 단말기 시뮬레이터. 관리 API로 설정·시작·정지하고 통계를 본다. 상태는 메모리에만 있다. */
export function createSimServer(fleet = new Fleet()): { server: Server; fleet: Fleet } {
  const server = createServer((req, res) => {
    route(fleet, req, res).catch((error: unknown) => {
      if (error instanceof BadJsonError && !res.headersSent) return sendJson(res, 400, { error: 'BAD_REQUEST', message: error.message });
      if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL', message: String(error) });
      else res.end();
    });
  });
  return { server, fleet };
}
