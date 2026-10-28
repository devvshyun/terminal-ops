import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api/client';

/** 조회 재시도 판정: 4xx는 다시 해도 같아서 안 하고, 연결 실패·5xx는 한 번만(어드민과 같은 규칙) */
export function shouldRetry(count: number, error: unknown): boolean {
  return !(error instanceof ApiError && error.status < 500) && count < 1;
}

/**
 * 서버 상태 캐시(TanStack Query). 휴대폰은 앱을 오가며 쓰므로 어드민과 달리 창으로 돌아올 때 다시 읽는다(refetchOnWindowFocus 기본값) —
 * 점주가 다른 앱에서 돌아왔을 때 배송·A/S 단계가 바뀌어 있을 수 있다. staleTime 30초라 금방 다시 와도 매번 읽지는 않는다.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 30_000 },
      mutations: { retry: false },
    },
  });
}
