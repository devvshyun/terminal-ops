import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api/client';

/** 조회 재시도 판정: 4xx는 다시 해도 같아서 안 하고, 연결 실패·5xx는 한 번만. 점주 앱 `apps/merchant/src/query-client.ts`의 사본(decisions/0062) — 주석을 뺀 코드가 같아야 한다(`src/copies.test.ts`가 본다). 고칠 때는 두 앱을 같이 고친다 */
export function shouldRetry(count: number, error: unknown): boolean {
  return !(error instanceof ApiError && error.status < 500) && count < 1;
}

/**
 * 서버 상태 캐시(TanStack Query). 점주 앱과 같게 창으로 돌아올 때 다시 읽는다(refetchOnWindowFocus 기본값) — 현장 작업자는 휴대폰·PDA에서
 * 다른 앱(메신저 등)을 오가고, 그사이 다른 작업자가 발주·검수 대기를 바꿨을 수 있다. staleTime 30초라 금방 다시 와도 매번 읽지는 않는다.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 30_000 },
      mutations: { retry: false },
    },
  });
}
