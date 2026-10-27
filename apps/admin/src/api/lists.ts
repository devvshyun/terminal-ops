import { useInfiniteQuery } from '@tanstack/react-query';
import { api, type Query } from './client';
import type { BeforeIdPage, WeeklyReportView } from './types';

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

/**
 * 주간 리포트 주 목록(서버: ?before=<주> → { items, nextBefore }). 주간 리포트 화면과 배치 실행 이력이 같은 키 ['weekly-reports']를
 * 쓰므로 키·queryFn·pageParam을 이 한 곳에 둔다 — 한쪽만 바뀌어 같은 키에 다른 queryFn이 붙지 않게(Day 6 최종 리뷰 Minor 1).
 */
export function useWeeklyReports() {
  return useInfiniteQuery({
    queryKey: ['weekly-reports'],
    queryFn: ({ pageParam }) => api<{ items: WeeklyReportView[]; nextBefore: string | null }>('/reports/weekly', { query: { before: pageParam ?? undefined } }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
  });
}
