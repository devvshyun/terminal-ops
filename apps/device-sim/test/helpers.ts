import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readJson, sendJson } from '../src/http.js';
import { createSimServer } from '../src/server.js';

export interface ReceivedRequest {
  path: string;
  body: Record<string, unknown>;
  /** 요청이 온 소켓(클라이언트 포트). keep-alive면 같은 값이 되풀이된다 */
  remotePort: number;
}

type Handler = (req: ReceivedRequest, res: ServerResponse) => Promise<void> | void;

/** 하트비트는 모두 OK로 답한다(우리 API의 응답 모양). */
export const okHandler: Handler = (req, res) => {
  const items = (req.body.items ?? []) as { serialNo: string }[];
  sendJson(res, 200, { accepted: items.length, results: items.map((i) => ({ serialNo: i.serialNo, result: 'OK' })) });
};

/** 가짜 우리 API. 받은 요청을 모으고, 동시에 처리 중인 요청 수의 최댓값을 센다. */
export async function startFakeApi(handler: Handler = okHandler) {
  const received: ReceivedRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let current = handler;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const r = { path: req.url ?? '', body: (await readJson(req)) ?? {}, remotePort: req.socket.remotePort ?? 0 };
        received.push(r);
        await current(r, res);
      } finally {
        inFlight -= 1;
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    maxInFlight: () => maxInFlight,
    setHandler: (h: Handler) => (current = h),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export type FakeApi = Awaited<ReturnType<typeof startFakeApi>>;

/** 빈 포트에 시뮬레이터 관리 서버를 띄운다. */
export async function startSim() {
  const { server, fleet } = createSimServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    base,
    fleet,
    post,
    get: async (path: string) => (await fetch(`${base}${path}`)).json(),
    close: async () => {
      await fleet.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
