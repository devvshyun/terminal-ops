import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OpsFailedJobsPage, OpsFailedJobView, OpsJobActionResult, OpsQueuesView } from '@terminal-ops/contracts';
import { api, ApiError } from '../api/client';
import { keys } from '../api/query-keys';
import { canOperate } from '../components/AuthGate';
import { ErrorBox } from '../components/ErrorBox';
import { Freshness } from '../components/Freshness';
import { formatKst } from '../lib/format';
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
  const [start, setStart] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const queues = useQuery({ queryKey: keys.queues, queryFn: () => api<OpsQueuesView>('/ops/queues'), refetchInterval });
  const names = queues.data?.queues ?? [];
  const selected = params.get('queue') ?? names.find((q) => q.counts.failed > 0)?.name ?? names[0]?.name ?? null;

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
    action.mutate({ kind, job });
  };

  const choose = (name: string) => {
    setStart(0);
    setNotice(null);
    setParams({ queue: name });
  };

  const page = failed.data;
  return (
    <>
      <h1>실패 job</h1>
      <div className="toolbar">
        <label>
          큐{' '}
          <select aria-label="큐" value={selected ?? ''} onChange={(e) => choose(e.target.value)}>
            {names.map((q) => (
              <option key={q.name} value={q.name}>
                {q.name} (실패 {q.counts.failed})
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
            <button type="button" disabled={start === 0} onClick={() => setStart(Math.max(0, start - PAGE_SIZE))}>
              이전
            </button>
            <span>
              {page.start + 1}–{page.start + page.items.length} / {page.total}
            </span>
            <button type="button" disabled={page.start + page.items.length >= page.total} onClick={() => setStart(start + PAGE_SIZE)}>
              다음
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}
