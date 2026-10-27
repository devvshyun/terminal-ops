import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { api } from '../../api/client';
import { ErrorBox } from '../../components/ErrorBox';
import { MoreButton } from '../../components/MoreButton';
import { RunningPoller } from '../../components/RunningPoller';
import { formatKst } from '../../lib/format';
import type { VanRunDetail } from '@terminal-ops/contracts';
import { keys } from '../../api/query-keys';

/** VAN 대조 실행 하나. 실행 번호가 바뀌면 key로 새로 그려 필터(종류·재검증)를 처음 값으로 되돌린다 */
export function VanRunDetailPage() {
  const id = useParams().id ?? '';
  return <VanRunDetail key={id} id={Number(id)} />;
}

/** 요약(종류별 수·단계별 시간)과 결과 항목(종류·재검증 여부로 거르고 afterId로 이어 본다) */
function VanRunDetail({ id }: { id: number }) {
  const [kind, setKind] = useState('');
  const [verified, setVerified] = useState('true');
  const detail = useInfiniteQuery({
    queryKey: keys.vanRun.items(id, kind, verified),
    queryFn: ({ pageParam }) =>
      api<VanRunDetail>(`/van-reconciliations/${id}`, { query: { kind, verified, afterId: pageParam ?? undefined, limit: 100 } }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextAfterId,
  });
  const run = detail.data?.pages[0];
  const items = detail.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section>
      <p>
        <Link to="/reports/van">← VAN 대조 목록</Link>
      </p>
      <h2>VAN 대조 #{id}</h2>
      <ErrorBox error={detail.error} />
      {run ? (
        <div className="panel">
          <dl className="info">
            <dt>상태</dt>
            <dd>
              <strong className={run.status === 'FAILED' ? 'bad' : undefined}>{run.status}</strong>
              {run.status === 'RUNNING' ? <RunningPoller refetch={detail.refetch} text="대조 진행 중" /> : null}
            </dd>
            <dt>기간</dt>
            <dd>
              {formatKst(run.startedAt)} ~ {formatKst(run.finishedAt)}
            </dd>
            <dt>수집</dt>
            <dd>
              {run.pages}쪽 {run.fetched}건(다시 부름 {run.retries}번)
            </dd>
            <dt>결과</dt>
            <dd>
              후보 {run.candidates} → 어긋남 {run.confirmed}, 재검증으로 풀림 {run.resolved}, 확인 불가 {run.unverifiable}
            </dd>
            <dt>단계 시간</dt>
            <dd>
              수집 {run.phaseMs.collect ?? '-'}ms · 비교 {run.phaseMs.compare ?? '-'}ms · 재검증 {run.phaseMs.reverify ?? '-'}ms
            </dd>
            {run.error ? (
              <>
                <dt>실패 이유</dt>
                <dd className="bad">{run.error}</dd>
              </>
            ) : null}
          </dl>
        </div>
      ) : null}
      <div className="filters">
        <select aria-label="종류" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">종류 전체</option>
          {Object.entries(run?.counts ?? {}).map(([code, n]) => (
            <option key={code} value={code}>
              {code} ({n})
            </option>
          ))}
        </select>
        <select aria-label="재검증" value={verified} onChange={(e) => setVerified(e.target.value)}>
          <option value="true">어긋남(재검증 뒤에도)</option>
          <option value="false">풀림·확인 불가</option>
          <option value="">전체</option>
        </select>
      </div>
      {run?.status === 'RUNNING' ? (
        <p className="muted">진행 중이라 재검증 결과가 아직 다 쌓이지 않았습니다. 끝나면(COMPLETED) 항목과 종류별 수가 바뀔 수 있습니다.</p>
      ) : null}
      <table>
        <thead>
          <tr>
            <th scope="col">시리얼</th>
            <th scope="col">종류</th>
            <th scope="col">우리</th>
            <th scope="col">VAN</th>
            <th scope="col">재검증</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id}>
              <td>{it.serialNo}</td>
              <td>{it.kindLabel}</td>
              <td>{it.ourValue}</td>
              <td>{it.vanValue}</td>
              <td>{it.verified ? '어긋남' : (it.reason ?? '풀림')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <MoreButton hasNextPage={detail.hasNextPage} isFetchingNextPage={detail.isFetchingNextPage} fetchNextPage={detail.fetchNextPage} />
    </section>
  );
}
