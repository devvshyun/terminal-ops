import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OpsFailedJobsPage, OpsFailedJobView, OpsJobActionResult, OpsQueuesView } from '@terminal-ops/contracts';
import { api, ApiError } from '../api/client';
import { keys } from '../api/query-keys';
import { canOperate } from '../components/AuthGate';
import { ErrorBox } from '../components/ErrorBox';
import { Freshness } from '../components/Freshness';
import { formatKst } from '../lib/format';
import { OPS_QUEUE_NAMES } from '../lib/labels';
import { useRefetchInterval } from '../lib/refresh';
import { useMe } from '../session';

export const PAGE_SIZE = 20;

type Action = 'retry' | 'remove';

const CONFIRM: Record<Action, (job: OpsFailedJobView) => string> = {
  retry: (job) => `${job.queue}의 job ${job.id}(${job.name})을(를) 다시 시도할까요? 시도 횟수를 0으로 되돌려 처음부터 다시 처리합니다.`,
  remove: (job) => `${job.queue}의 job ${job.id}(${job.name})을(를) 지울까요? 되돌릴 수 없습니다.`,
};

const DONE: Record<Action, string> = { retry: '다시 시도했습니다', remove: '지웠습니다' };

function JobRow({ job, operate, onAction, busy }: { job: OpsFailedJobView; operate: boolean; onAction: (action: Action, job: OpsFailedJobView) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr>
        <td>{formatKst(job.failedAt)}</td>
        <td>
          <code>{job.id}</code>
          <div className="muted">{job.name}</div>
        </td>
        <td className="num">
          {job.attemptsMade}/{job.maxAttempts}
        </td>
        <td>{job.failedReason}</td>
        <td>
          <div className="toolbar">
            <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? '접기' : '자세히'}
            </button>
            {operate ? (
              <>
                <button type="button" className="primary" disabled={busy} onClick={() => onAction('retry', job)}>
                  다시 시도
                </button>
                <button type="button" className="danger" disabled={busy} onClick={() => onAction('remove', job)}>
                  지우기
                </button>
              </>
            ) : null}
          </div>
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={5}>
            <div className="muted">넣은 시각 {formatKst(job.createdAt)} · data(비밀처럼 보이는 이름의 값은 가림)</div>
            <pre>{JSON.stringify(job.data, null, 2)}</pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * 실패 job(보강 6, decisions/0072): 큐를 고르면 Redis에 남은 실패 job을 최근부터 20개씩. 자세히 = data(가린 것)·넣은 시각.
 * 다시 시도·지우기는 관제만(확인창 뒤). 성공하면 큐 요약·실패 목록·작업 기록을 다시 읽고, 409(이미 실패 상태 아님)·404(없음)여도 목록을 다시 읽는다.
 * 끝나면 지우는 job(알림·택배 추적·주간 리포트 수동 보내기)의 실패는 여기 없다 — "최근 오류" 화면이 업무 기록으로 보인다.
 */
export function FailedJobsPage() {
  const me = useMe();
  const operate = canOperate(me?.role);
  const client = useQueryClient();
  const refetchInterval = useRefetchInterval();
  const [params, setParams] = useSearchParams();
  const [notice, setNotice] = useState<string | null>(null);

  const queues = useQuery({ queryKey: keys.queues, queryFn: () => api<OpsQueuesView>('/ops/queues'), refetchInterval });
  // 큐 요약을 못 읽으면(503 등) contracts의 큐 이름으로 고르기를 채운다 — 실패 수는 모름(Task 2·3 리뷰 반영). 처음 읽는 중에는 비워 둔다(첫 큐를 읽었다가 바꾸지 않게)
  const names: { name: string; failed: number | null }[] = queues.data
    ? queues.data.queues.map((q) => ({ name: q.name, failed: q.counts.failed }))
    : queues.isError
      ? OPS_QUEUE_NAMES.map((name) => ({ name, failed: null }))
      : [];
  const pinned = params.get('queue');
  const selected = pinned ?? names.find((q) => (q.failed ?? 0) > 0)?.name ?? names[0]?.name ?? null;
  // 쪽(start)도 주소에 — 큐와 함께 둔다(최종 리뷰 Minor 2). 큐를 바꾸면(고르기·메뉴 "실패 job"으로 ?queue=가 빠짐) start가 빠져 첫 쪽부터.
  // 큐가 주소에 없을 때(실패가 있는 첫 큐를 고른 것)는 start를 보지 않는다 — 그 큐가 말없이 바뀌어도 앞 큐의 쪽을 이어 쓰지 않게
  const startParam = Number(params.get('start'));
  const start = pinned !== null && Number.isInteger(startParam) && startParam > 0 ? startParam : 0;
  const goTo = (queue: string, nextStart: number, replace = false) =>
    setParams(nextStart > 0 ? { queue, start: String(nextStart) } : { queue }, { replace });

  const failed = useQuery({
    queryKey: keys.failed(selected ?? '', start),
    queryFn: () => api<OpsFailedJobsPage>(`/ops/queues/${encodeURIComponent(selected!)}/failed`, { query: { start, limit: PAGE_SIZE } }),
    enabled: selected !== null,
    refetchInterval,
  });

  const action = useMutation({
    mutationFn: ({ kind, job }: { kind: Action; job: OpsFailedJobView }) =>
      api<OpsJobActionResult>(`/ops/queues/${encodeURIComponent(job.queue)}/jobs/${encodeURIComponent(job.id)}/${kind}`, { method: 'POST' }),
    onSuccess: (result, { kind }) => setNotice(`${result.queue}의 job ${result.jobId}을(를) ${DONE[kind]}(작업 기록 #${result.actionId}).`),
    onSettled: (_data, error) => {
      if (error && !(error instanceof ApiError && (error.status === 409 || error.status === 404))) return;
      void client.invalidateQueries({ queryKey: keys.queues });
      void client.invalidateQueries({ queryKey: keys.failedAll });
      void client.invalidateQueries({ queryKey: keys.actions });
    },
  });

  const onAction = (kind: Action, job: OpsFailedJobView) => {
    if (!window.confirm(CONFIRM[kind](job))) return;
    setNotice(null);
    // 큐를 주소에 고정한다 — 고르지 않은 채(실패가 있는 첫 큐) 그 큐의 마지막 job을 처리하면 무효화 뒤 고른 큐가 말없이 다른 큐로 바뀌었다(최종 리뷰 Minor 2).
    // 응답 뒤가 아니라 부르기 전에: 응답 뒤에 고정하면 무효화 뒤 잠깐 다른 큐를 한 번 읽었다(테스트에서 봄 — 주소 반영이 큐 요약보다 늦은 것으로 추측)
    if (pinned === null) goTo(job.queue, start, true);
    action.mutate({ kind, job });
  };

  const choose = (name: string) => {
    setNotice(null);
    goTo(name, 0);
  };

  const page = failed.data;
  // 지금 쪽이 비었는데 앞에 job이 남았으면(둘째 쪽의 마지막 job을 처리함) 남은 마지막 쪽으로 옮긴다(최종 리뷰 Minor 2)
  useEffect(() => {
    if (selected && page && page.items.length === 0 && page.start > 0) goTo(selected, page.total > 0 ? Math.floor((page.total - 1) / PAGE_SIZE) * PAGE_SIZE : 0, true);
    // goTo는 렌더마다 새 함수라 의존에서 뺀다(같은 selected·page면 다시 옮기지 않음)
  }, [selected, page]);
  return (
    <>
      <h1>실패 job</h1>
      <div className="toolbar">
        <label>
          큐{' '}
          <select aria-label="큐" value={selected ?? ''} onChange={(e) => choose(e.target.value)}>
            {names.map((q) => (
              <option key={q.name} value={q.name}>
                {q.name} (실패 {q.failed ?? '?'})
              </option>
            ))}
          </select>
        </label>
        {operate ? null : <span className="muted">다시 시도·지우기는 관제 계정만 할 수 있습니다(ADMIN은 보기만).</span>}
      </div>
      <Freshness updatedAt={failed.dataUpdatedAt} fetching={failed.isFetching} error={failed.error ?? queues.error} />
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      <ErrorBox error={action.error} />
      {page && page.items.length === 0 ? <p>이 큐에 남은 실패 job이 없습니다.</p> : null}
      {page && page.items.length > 0 ? (
        <>
          <table>
            <thead>
              <tr>
                <th>실패 시각</th>
                <th>job</th>
                <th className="num">시도</th>
                <th>실패 이유</th>
                <th>할 일</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((job) => (
                <JobRow key={job.id} job={job} operate={operate} onAction={onAction} busy={action.isPending} />
              ))}
            </tbody>
          </table>
          <div className="toolbar">
            <button type="button" disabled={start === 0} onClick={() => goTo(selected!, Math.max(0, start - PAGE_SIZE))}>
              이전
            </button>
            <span>
              {page.start + 1}–{page.start + page.items.length} / {page.total}
            </span>
            <button type="button" disabled={page.start + page.items.length >= page.total} onClick={() => goTo(selected!, start + PAGE_SIZE)}>
              다음
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}
