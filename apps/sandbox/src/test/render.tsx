import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { App } from '../App';

/** 부른 요청 하나 */
export interface Call {
  method: string;
  /** /partners·/sim을 포함한 경로(쿼리 제외). 앞의 /api는 뗀다 — 실제로 /api 아래로 보냈는지는 url로 본다 */
  path: string;
  /** 화면이 부른 그대로의 경로(/api/… — Vite 프록시 앞마디, decisions/0084 보탬) */
  url: string;
  query: URLSearchParams;
  body: unknown;
}

type Result = { status?: number; body?: unknown } | 'down';
export type Handler = (call: Call) => Result | Promise<Result>;

/**
 * 가짜 두 서버. 키는 'GET /partners/__admin/config'처럼. 'down'을 돌려주면 연결 실패(fetch가 던짐)를 흉내 낸다.
 * 없는 경로는 404 — 테스트가 빠뜨린 요청이 바로 보이게.
 */
export function mockServers(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://sandbox.test');
      const call: Call = {
        method: init?.method ?? 'GET',
        path: url.pathname.replace(/^\/api/, ''),
        url: url.pathname,
        query: url.searchParams,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const handler = handlers[`${call.method} ${call.path}`];
      const result = handler ? await handler(call) : { status: 404, body: { error: 'NO_ROUTE', message: `가짜 서버에 없음: ${call.method} ${call.path}` } };
      if (result === 'down') throw new TypeError('Failed to fetch');
      return new Response(result.body === undefined ? null : JSON.stringify(result.body), { status: result.status ?? 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return { calls };
}

export function renderApp(route = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}
