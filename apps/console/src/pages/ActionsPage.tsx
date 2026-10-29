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
 */
export function ActionsPage() {
  const refetchInterval = useRefetchInterval();
  const list = useInfiniteQuery({
    queryKey: keys.actions,
    queryFn: ({ pageParam }) => api<BeforeIdPage<OpsActionView>>('/ops/actions', { query: { beforeId: pageParam } }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBeforeId ?? undefined,
    refetchInterval,
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
