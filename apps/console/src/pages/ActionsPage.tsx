import { useInfiniteQuery } from '@tanstack/react-query';
import type { BeforeIdPage, OpsActionView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { Freshness } from '../components/Freshness';
import { formatKst } from '../lib/format';
import { ACTION_LABEL } from '../lib/labels';
import { useRefetchInterval } from '../lib/refresh';

/**
 * 작업 기록(보강 6, decisions/0073): 관제 작업(다시 시도·지우기·Outbox 복구 sweep)을 누가 언제 무엇에 했나, 최근부터 20개씩 "더 보기".
 * 고치거나 지우는 단추는 없다(api도 없다 — 쌓기만).
 * 자동 새로고침은 첫 쪽만 펼쳤을 때만 — "더 보기" 뒤에는 멈춘다(위의 마지막 갱신 시각이 그대로 남는다).
 */
export function ActionsPage() {
  const refetchInterval = useRefetchInterval();
  const list = useInfiniteQuery({
    queryKey: keys.actions,
    queryFn: ({ pageParam }) => api<BeforeIdPage<OpsActionView>>('/ops/actions', { query: { beforeId: pageParam } }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBeforeId ?? undefined,
    // 무한 목록의 간격 다시 읽기는 펼친 쪽을 모두 차례로 다시 읽는다 — "더 보기"를 누른 뒤에는 멈춘다(최종 리뷰 Minor 6a, decisions/0076 보탬).
    // 첫 쪽만 볼 때는 다른 화면처럼 10초. 관제 작업 뒤의 무효화(작업 기록 키)는 그대로 다시 읽는다
    refetchInterval: (query) => ((query.state.data?.pages.length ?? 0) > 1 ? false : refetchInterval),
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <h1>작업 기록</h1>
      <Freshness updatedAt={list.dataUpdatedAt} fetching={list.isFetching} error={list.error} />
      {list.data && items.length === 0 ? <p>아직 관제 작업이 없습니다.</p> : null}
      {items.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>시각</th>
              <th>누가</th>
              <th>작업</th>
              <th>대상</th>
              <th>그때 사정</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td>{formatKst(a.createdAt)}</td>
                <td>
                  {a.actor} ({a.actorRole})
                </td>
                <td>{ACTION_LABEL[a.action]}</td>
                <td>{a.queue ? `${a.queue} / ${a.jobId} (${a.jobName})` : 'Outbox'}</td>
                <td>{a.detail ? <pre>{JSON.stringify(a.detail)}</pre> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {list.hasNextPage ? (
        <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          더 보기
        </button>
      ) : null}
    </>
  );
}
