import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { api, downloadUrl } from '../../api/client';
import { useWeeklyReports } from '../../api/lists';
import type { WeeklyReportView } from '../../api/types';
import { ErrorBox } from '../../components/ErrorBox';
import { MoreButton } from '../../components/MoreButton';
import { RunningPoller } from '../../components/RunningPoller';
import { WriteButton } from '../../components/WriteButton';
import { formatKst, kstToday } from '../../lib/format';
import { keys } from '../../api/query-keys';

export type { WeeklyReportView };

/** 이만큼 넘게 대기열에 있으면 워커가 안 도는 것을 의심한다(decisions/0038 — 워커가 없으면 job이 waiting에 남는다) */
export const WORKER_HINT_AFTER_MIN = 10;

/** 대기열에 들어간 지 몇 분째인지(내림, 음수 없음), 들어간 시각(KST), 워커 확인 안내가 필요한지. queuedAt이 없으면 null */
export function queueWait(queuedAt: string | null, now = new Date()): { minutes: number; since: string; stuck: boolean } | null {
  if (!queuedAt) return null;
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(queuedAt).getTime()) / 60_000));
  return { minutes, since: formatKst(queuedAt), stuck: minutes >= WORKER_HINT_AFTER_MIN };
}

/** 오늘(KST)이 속한 주의 앞 주 월요일 'YYYY-MM-DD' — 주간 리포트의 기본 대상(서버의 previousKstWeek와 같은 뜻) */
export function lastWeekMonday(today = kstToday()): string {
  const d = new Date(`${today}T00:00:00Z`);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - sinceMonday - 7);
  return d.toISOString().slice(0, 10);
}

/**
 * 보낼 주로 고른 값의 문제(없으면 null). 월요일만, 지난주 월요일(max)까지만 — 끝나지 않은 주는 서버도 422 WEEK_NOT_ENDED.
 * 'YYYY-MM-DD'끼리는 문자열 비교가 날짜 순서와 같다.
 */
export function weekStartProblem(value: string, max = lastWeekMonday()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '주를 고르세요.';
  if (new Date(`${value}T00:00:00Z`).getUTCDay() !== 1) return '월요일을 고르세요.';
  if (value > max) return `${max} 주까지만 보낼 수 있습니다(끝나지 않은 주).`;
  return null;
}

/**
 * 주간 운영 리포트(F11): 주 목록, 보내기(비동기 202 — 대기열에 있는 동안 2초마다 다시 읽는다, decisions/0038), xlsx 내려받기.
 * 끝나지 않은 주는 서버가 422 WEEK_NOT_ENDED로 거절한다.
 */
export function WeeklyReportsPage() {
  const client = useQueryClient();
  const maxWeek = lastWeekMonday();
  // 배치 실행 이력의 행 링크(?week=)로 들어오면 그 주를 처음 값으로 — 다시 보낼 주를 이어 받는다. 모양이 틀리면 지난주 월요일
  const [params] = useSearchParams();
  const linkedWeek = params.get('week');
  const fromLink = linkedWeek && /^\d{4}-\d{2}-\d{2}$/.test(linkedWeek) ? linkedWeek : null;
  const [weekStart, setWeekStart] = useState(fromLink ?? maxWeek);
  const weekProblem = weekStartProblem(weekStart, maxWeek);
  const list = useWeeklyReports();
  const send = useMutation({
    mutationFn: (week: string) => api<WeeklyReportView>('/reports/weekly', { method: 'POST', body: { weekStart: week } }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.weeklyReports.all }),
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const queued = items.some((r) => r.queued);
  /** 대기 시간의 기준 = 마지막으로 읽은 시각. 2초마다 다시 읽을 때 응답이 같아도 dataUpdatedAt은 바뀌어 "N분째"가 올라간다 */
  const readAt = new Date(list.dataUpdatedAt || Date.now());

  return (
    <section>
      <h2>주간 운영 리포트</h2>
      <div className="filters">
        <label>
          주(월요일){' '}
          <input aria-label="보낼 주" type="date" max={maxWeek} value={weekStart} onChange={(e) => setWeekStart(e.target.value)} />
        </label>
        <WriteButton className="primary" disabled={weekProblem !== null || send.isPending} onClick={() => send.mutate(weekStart)}>
          보내기
        </WriteButton>
        {weekProblem ? <span className="bad">{weekProblem}</span> : null}
        {queued ? <RunningPoller refetch={list.refetch} text="보내는 중" /> : null}
      </div>
      {send.data ? (
        <p role="status">
          {send.data.weekStart} 주: {send.data.alreadySent ? '이미 보낸 주입니다.' : '보내기 대기열에 넣었습니다.'}
        </p>
      ) : null}
      <ErrorBox error={list.error ?? send.error} />
      <table>
        <thead>
          <tr>
            <th scope="col">주</th>
            <th scope="col">상태</th>
            <th scope="col">보낸 시각</th>
            <th scope="col">시도</th>
            <th scope="col">마지막 오류</th>
            <th scope="col">파일</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {items.map((r) => {
            const wait = r.queued ? queueWait(r.queuedAt, readAt) : null;
            // 대기열에 있는 동안의 lastError는 지난 시도의 것이다 — 지금 보내는 중인데 실패처럼 보이지 않게 숨긴다
            const lastError = r.queued ? null : r.lastError;
            return (
              <tr key={r.weekStart} aria-current={r.weekStart === fromLink ? 'true' : undefined}>
                <td>{r.weekStart}</td>
                <td>
                  {r.status}
                  {r.queued ? <span className="badge">대기열</span> : null}
                  {wait ? (
                    <div className="muted" title={`${wait.since}부터`}>
                      {wait.minutes}분째 대기({wait.since}부터)
                    </div>
                  ) : null}
                  {wait?.stuck ? (
                    <div className="bad">{WORKER_HINT_AFTER_MIN}분 넘게 대기 중입니다. 워커가 실행 중인지 확인하세요(RUN_WORKERS 또는 워커 프로세스).</div>
                  ) : null}
                </td>
                <td>{formatKst(r.sentAt)}</td>
                <td>{r.attempts}</td>
                <td className={lastError ? 'bad' : undefined}>{lastError ?? ''}</td>
                <td>
                  {r.fileSize ? (
                    <a href={downloadUrl(`/reports/weekly/${r.weekStart}/file`)} download>
                      xlsx ({r.fileSize.toLocaleString()}바이트)
                    </a>
                  ) : (
                    '-'
                  )}
                </td>
                <td>
                  {r.status !== 'SENT' && !r.queued ? (
                    <WriteButton disabled={send.isPending} onClick={() => send.mutate(r.weekStart)}>
                      다시 보내기
                    </WriteButton>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <MoreButton hasNextPage={list.hasNextPage} isFetchingNextPage={list.isFetchingNextPage} fetchNextPage={list.fetchNextPage} />
    </section>
  );
}
