import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../../api/client';
import { itemsOf, useBeforeIdList } from '../../api/lists';
import { ErrorBox } from '../../components/ErrorBox';
import { MoreButton } from '../../components/MoreButton';
import { RunningPoller } from '../../components/RunningPoller';
import { WriteButton } from '../../components/WriteButton';
import { formatKst } from '../../lib/format';
import { keys } from '../../api/query-keys';
import type { StartVanReconciliationRequest, VanRunView } from '@terminal-ops/contracts';

/**
 * VAN 등록 대조(F9) 실행 목록과 수동 실행. 실행은 비동기(202) — 목록이 RUNNING이면 저절로 다시 읽는다.
 * 실행 버튼은 RUNNING 행이 있어도 끄지 않는다: 진행 중이면 서버가 409 VAN_RECONCILIATION_RUNNING으로 막고,
 * 하트비트가 끊긴 RUNNING 행은 서버 start()의 failStale이 그 요청에서 FAILED로 정리한다(Day 6 최종 리뷰 Important 1).
 */
export function VanRunsPage() {
  const client = useQueryClient();
  const [acknowledgeDrop, setAcknowledgeDrop] = useState(false);
  const list = useBeforeIdList<VanRunView>(keys.vanRuns.all, '/van-reconciliations');
  const runs = itemsOf(list.data);
  const running = runs.some((r) => r.status === 'RUNNING');
  const start = useMutation({
    mutationFn: () => api<VanRunView>('/van-reconciliations', { method: 'POST', body: { acknowledgeDrop } satisfies StartVanReconciliationRequest }),
    onSuccess: () => {
      setAcknowledgeDrop(false);
      return client.invalidateQueries({ queryKey: keys.vanRuns.all });
    },
  });

  return (
    <section>
      <h2>VAN 등록 대조</h2>
      <div className="filters">
        <label>
          <input type="checkbox" checked={acknowledgeDrop} onChange={(e) => setAcknowledgeDrop(e.target.checked)} /> 수집 급감 확인함(이번 실행만 급감 검사 건너뜀)
        </label>
        <WriteButton className="primary" roles={['OPERATOR', 'MONITOR']} disabled={start.isPending} onClick={() => start.mutate()}>
          대조 실행
        </WriteButton>
        <button type="button" onClick={() => void list.refetch()}>
          새로고침
        </button>
        {running ? <RunningPoller refetch={list.refetch} text="대조 진행 중" /> : null}
      </div>
      <ErrorBox error={list.error ?? start.error} />
      <table>
        <thead>
          <tr>
            <th scope="col">번호</th>
            <th scope="col">상태</th>
            <th scope="col">시작</th>
            <th scope="col">끝</th>
            <th scope="col">VAN 등록</th>
            <th scope="col">후보</th>
            <th scope="col">어긋남</th>
            <th scope="col">풀림</th>
            <th scope="col">확인 불가</th>
            <th scope="col">요청</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>
                <Link to={`/reports/van/${r.id}`}>#{r.id}</Link>
              </td>
              <td className={r.status === 'FAILED' ? 'bad' : undefined} title={r.error ?? undefined}>
                {r.status}
              </td>
              <td>{formatKst(r.startedAt)}</td>
              <td>{formatKst(r.finishedAt)}</td>
              <td>{r.fetched}</td>
              <td>{r.candidates}</td>
              <td>{r.confirmed}</td>
              <td>{r.resolved}</td>
              <td>{r.unverifiable}</td>
              <td>
                {r.trigger === 'SCHEDULED' ? '주기' : r.requestedBy}
                {r.acknowledgeDrop ? ' (급감 확인)' : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <MoreButton hasNextPage={list.hasNextPage} isFetchingNextPage={list.isFetchingNextPage} fetchNextPage={list.fetchNextPage} />
    </section>
  );
}
