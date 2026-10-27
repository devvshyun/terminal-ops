import { useInfiniteQuery } from '@tanstack/react-query';
import { api, type Query } from './client';
import type { BeforeIdPage } from './types';

/**
 * 최근 것부터 "더 보기" 목록(서버: ?beforeId=&limit= → { items, nextBeforeId }, decisions/0039).
 * 쪽마다 따로 캐시하고 화면은 pages를 이어 붙여 보여 준다. 조건(query)이 바뀌면 처음부터.
 */
export function useBeforeIdList<T>(key: string, path: string, query: Query = {}) {
  return useInfiniteQuery({
    queryKey: [key, query],
    queryFn: ({ pageParam }) => api<BeforeIdPage<T>>(path, { query: { ...query, beforeId: pageParam ?? undefined } }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBeforeId,
  });
}

/** 이어 붙인 항목 */
export function itemsOf<T>(data: { pages: BeforeIdPage<T>[] } | undefined): T[] {
  return data?.pages.flatMap((p) => p.items) ?? [];
}
