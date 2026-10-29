import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api/client';

/** 조회 재시도 판정: 4xx는 다시 해도 같아서 안 하고, 연결 실패·5xx는 한 번만. 점주 앱 `apps/merchant/src/query-client.ts`의 사본(decisions/0062) — 주석을 뺀 코드가 같아야 한다(`src/copies.test.ts`가 본다). 고칠 때는 두 앱을 같이 고친다 */
export function shouldRetry(count: number, error: unknown): boolean {
  return !(error instanceof ApiError && error.status < 500) && count < 1;
}

/**
 * 서버 상태 캐시(TanStack Query). 점주 앱과 같은 기본값 — 관제 화면은 읽기 쿼리마다 refetchInterval(10초, lib/refresh.ts)을 따로 걸어
 * staleTime(30초)과 상관없이 간격마다 다시 읽는다. 탭으로 돌아올 때 다시 읽기(refetchOnWindowFocus)는 30초가 지났을 때만(decisions/0076).
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 30_000 },
      mutations: { retry: false },
    },
  });
}
