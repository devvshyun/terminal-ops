import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { defaultConfig, invalidPatchReason, invalidReason, publicConfig, withoutMaskedKey, type SimConfig } from './config.js';
import { Fleet } from './fleet.js';
import { BadJsonError, readJson, sendJson } from './http.js';

/** 상태를 바꾸는 관리 요청(config·start·stop·reset)을 하나씩 차례로 처리하는 줄 */
type Serialize = <T>(fn: () => Promise<T>) => Promise<T>;

function createSerializer(): Serialize {
  let chain: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };
}

async function route(fleet: Fleet, serialize: Serialize, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://device-sim').pathname;
  const method = req.method ?? 'GET';
  let m: RegExpMatchArray | null;

  if (method === 'GET' && path === '/__admin/health') return sendJson(res, 200, { status: 'ok' });
  if (method === 'GET' && path === '/__admin/config') return sendJson(res, 200, publicConfig(fleet.config));
  if (method === 'POST' && path === '/__admin/config') {
    const patch = withoutMaskedKey((await readJson(req)) ?? {});
    const patchReason = invalidPatchReason(patch);
    if (patchReason) return sendJson(res, 400, { error: 'BAD_CONFIG', message: patchReason });
    return serialize(async () => {
      // 줄 안에서 현재 설정과 합친다(앞 요청의 변경을 덮어쓰지 않는다)
      const next = { ...fleet.config, ...patch } as SimConfig;
      const reason = invalidReason(next);
      if (reason) return sendJson(res, 400, { error: 'BAD_CONFIG', message: reason });
      // 보내는 중인 요청만 기다린 뒤 바꾸고, 돌던 중이었으면 새 설정(주기 포함)으로 다시 돈다.
      // configure가 던지면 이전 설정이 그대로 남으므로, 그 설정으로라도 다시 돌린다.
      const wasRunning = fleet.running;
      await fleet.stop();
      try {
        fleet.configure(next);
      } finally {
        if (wasRunning) fleet.start();
      }
      return sendJson(res, 200, publicConfig(fleet.config));
    });
  }
  if (method === 'POST' && path === '/__admin/start') {
    return serialize(async () => {
      fleet.start();
      return sendJson(res, 200, { running: true });
    });
  }
  if (method === 'POST' && path === '/__admin/stop') {
    return serialize(async () => {
      await fleet.stop();
      return sendJson(res, 200, { running: false });
    });
  }
  if (method === 'POST' && path === '/__admin/reset') {
    return serialize(async () => {
      await fleet.reset(defaultConfig());
      return sendJson(res, 200, publicConfig(fleet.config));
    });
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
  const serialize = createSerializer();
  const server = createServer((req, res) => {
    route(fleet, serialize, req, res).catch((error: unknown) => {
      if (error instanceof BadJsonError && !res.headersSent) return sendJson(res, 400, { error: 'BAD_REQUEST', message: error.message });
      if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL', message: String(error) });
      else res.end();
    });
  });
  return { server, fleet };
}
