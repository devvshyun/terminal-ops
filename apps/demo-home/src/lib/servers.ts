/**
 * 두 서버의 관리 API를 부르는 곳(보강 8, decisions/0084 — 시연 도구 apps/sandbox의 같은 파일에서 옮김, 시연 홈 보강 10). Vite 프록시가 /api/partners → :4010, /api/sim → :4020으로 넘긴다.
 * 서버가 안 떠 있으면 프록시가 502·504를 내거나 연결이 끊긴다 — 둘 다 ServerDown으로 바꿔 "띄우는 명령"을 안내한다.
 */
export type Server = 'partners' | 'sim';

export const SERVER_INFO: Record<Server, { label: string; port: number; start: string }> = {
  partners: { label: '가상 업체 서버', port: 4010, start: 'cd apps/partners && npm run build && npm start' },
  sim: { label: '단말기 시뮬레이터', port: 4020, start: 'cd apps/device-sim && npm run build && npm start' },
};

/** 서버가 응답하지 않는다(안 떠 있음) */
export class ServerDown extends Error {
  constructor(readonly server: Server) {
    super(`${SERVER_INFO[server].label}(:${SERVER_INFO[server].port})에 연결하지 못했습니다.`);
  }
}

/** 서버가 2xx가 아닌 응답을 냈다(설정 값이 틀림 등). 본문의 message를 그대로 */
export class ServerError extends Error {
  constructor(
    readonly server: Server,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function call<T>(server: Server, path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/${server}${path}`, {
      method: init.method ?? 'GET',
      headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ServerDown(server);
  }
  // 프록시가 대상에 연결하지 못하면 502(Bad Gateway)·504
  if (res.status === 502 || res.status === 504) throw new ServerDown(server);
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // JSON이 아닌 본문(오류 페이지 등) — "연결 못 함"이 아니라 그 서버의 응답으로 보인다(시연 홈 최종 검토)
    throw new ServerError(server, res.status, `JSON이 아닌 응답(HTTP ${res.status}): ${text.slice(0, 120)}`);
  }
  if (!res.ok) {
    const message = (body as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`;
    throw new ServerError(server, res.status, message);
  }
  return body as T;
}
