import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { vi } from 'vitest';
import type { Role } from '@terminal-ops/contracts';
import { setMe } from '../session';

/** 부른 요청 하나(가짜 fetch가 기록) */
export interface Call {
  method: string;
  /** /api를 뗀 경로(쿼리 제외) */
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
}

type HandlerResult = { status?: number; body?: unknown } | undefined;

/** 응답을 늦추고 싶으면 Promise를 돌려준다(느린 응답 테스트) */
export type Handler = (call: Call) => HandlerResult | Promise<HandlerResult>;

/**
 * 가짜 api. 키는 'GET /terminals'처럼 메서드와 경로(쿼리 제외, /api 뗀 것). 경로의 `:x`는 아무 한 마디와 맞는다.
 * 없는 경로를 부르면 404 { message } — 테스트가 빠뜨린 요청이 바로 보이게. 부른 요청은 calls에 쌓인다.
 */
export function mockApi(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  const patterns = Object.entries(handlers).map(([key, handler]) => {
    const [method, path] = key.split(' ');
    const regex = new RegExp(`^${path.replace(/:[^/]+/g, '[^/]+')}$`);
    return { method, regex, handler };
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://admin.test');
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace(/^\/api/, ''),
      query: url.searchParams,
      // JSON 본문은 읽어 두고, 파일 올리기(FormData)는 그대로 둔다 — 테스트가 call.body.get('file')로 본다(보강 5)
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body instanceof FormData ? init.body : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const found = patterns.find((p) => p.method === call.method && p.regex.test(call.path));
    const result = found ? ((await found.handler(call)) ?? {}) : { status: 404, body: { statusCode: 404, message: `가짜 api에 없음: ${call.method} ${call.path}` } };
    const status = result.status ?? 200;
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), { // 204는 본문이 있으면 Response가 던진다
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

/** 화면 하나를 라우터·쿼리 캐시와 함께 그린다. path는 Route 경로(예 '/terminals/:serialNo'), route는 지금 주소 */
export function renderPage(element: ReactElement, { route = '/', path = '/' }: { route?: string; path?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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

/** 로그인한 것으로 둔다(서버 세션 대신 화면의 내 정보만 — 쓰기 버튼이 켜지게). 기본 운영자 */
export function loginAs(name = '김운영', role: Role = 'OPERATOR', merchantCode: string | null = null) {
  setMe({ loginId: name, displayName: name, role, merchantCode });
}
