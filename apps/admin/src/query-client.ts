import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api/client';

/** 조회 재시도 판정: 4xx는 다시 해도 같아서 안 하고, 연결 실패·5xx는 한 번만 */
export function shouldRetry(count: number, error: unknown): boolean {
  return !(error instanceof ApiError && error.status < 500) && count < 1;
}

/**
 * 서버 상태 캐시(TanStack Query, decisions/0041). 4xx는 다시 해도 같아서 재시도하지 않는다(연결 실패·5xx만 한 번).
 * 창으로 돌아올 때 자동으로 다시 읽지 않는다 — 운영자가 보던 값이 갑자기 바뀌지 않게(필요하면 화면의 새로고침 버튼).
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        refetchOnWindowFocus: false,
        staleTime: 5_000,
      },
      mutations: { retry: false },
    },
  });
}
