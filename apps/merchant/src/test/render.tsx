import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { vi } from 'vitest';
import type { MeView } from '@terminal-ops/contracts';
import { App } from '../App';
import { setMe } from '../session';

/** 부른 요청 하나(가짜 fetch가 기록) */
export interface Call {
  method: string;
  /** /api를 뗀 경로(쿼리 제외) */
  path: string;
  query: URLSearchParams;
  body: unknown;
}

type HandlerResult = { status?: number; body?: unknown } | undefined;
export type Handler = (call: Call) => HandlerResult | Promise<HandlerResult>;

/**
 * 가짜 api(어드민 test/render.tsx의 mockApi와 같은 규칙). 키는 'GET /me/terminals'처럼 메서드와 경로(쿼리 제외). 경로의 `:x`는 아무 한 마디와 맞는다.
 * 없는 경로를 부르면 404 — 테스트가 빠뜨린 요청이 바로 보이게. 부른 요청은 calls에 쌓인다.
 */
export function mockApi(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  const patterns = Object.entries(handlers).map(([key, handler]) => {
    const [method, path] = key.split(' ');
    return { method, regex: new RegExp(`^${path.replace(/:[^/]+/g, '[^/]+')}$`), handler };
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://merchant.test');
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace(/^\/api/, ''),
      query: url.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const found = patterns.find((p) => p.method === call.method && p.regex.test(call.path));
    const result = found ? ((await found.handler(call)) ?? {}) : { status: 404, body: { statusCode: 404, message: `가짜 api에 없음: ${call.method} ${call.path}` } };
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

/** 화면 하나를 라우터·쿼리 캐시와 함께 그린다. path는 Route 경로(예 '/terminals/:serialNo'), route는 지금 주소 */
export function renderPage(element: ReactElement, { route = '/', path = '/' }: { route?: string; path?: string } = {}) {
  const client = newClient();
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path={path} element={element} />
            <Route path="*" element={<p>다른 화면</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

/** 앱 전체(로그인 문·화면 틀 포함)를 이 주소로 그린다 */
export function renderApp(route = '/') {
  const client = newClient();
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

/** 강남김밥 점주(시연 계정과 같은 아이디·가맹점) */
export const OWNER: MeView = { loginId: 'merchant-gangnam', displayName: '강남김밥 점주', role: 'MERCHANT', merchantCode: 'GANGNAM-KIMBAP' };

/** 로그인한 것으로 둔다(서버 세션 대신 화면의 내 정보만) */
export function loginAs(me: MeView = OWNER) {
  setMe(me);
}
