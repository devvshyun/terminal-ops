import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api/client';
import { itemsOf, useBeforeIdList } from '../api/lists';
import { ErrorBox } from '../components/ErrorBox';
import { MoreButton } from '../components/MoreButton';
import { formatKst } from '../lib/format';
import type { VanRunView } from './reports/VanRunsPage';
import type { WeeklyReportView } from './reports/WeeklyReportsPage';

interface SyncRunView {
  id: number;
  job: string;
  shipmentId: number | null;
  trackingNo: string | null;
  attempt: number;
  worker: string;
  outcome: string;
  startedAt: string;
  finishedAt: string | null;
  fetched: number;
  inserted: number;
  duplicated: number;
  detail: string | null;
}

const TABS = [
  { key: 'sync', label: '택배 수집' },
  { key: 'van', label: 'VAN 대조' },
  { key: 'weekly', label: '주간 리포트' },
] as const;
type Tab = (typeof TABS)[number]['key'];

const OUTCOMES = ['OK', 'DELIVERED', 'NOOP', 'SKIPPED', 'ERROR'];

/**
 * 배치 실행 이력: 실행마다 행을 남기는 배치 세 가지(택배 수집 SyncRun, VAN 대조 실행, 주간 리포트 주별 행).
 * 이상 단말기 찾기는 실행 기록 표가 없다 — 결과는 이상 단말기 화면(열린 이상)과 알림으로 본다(decisions/0039).
 */
export function BatchHistoryPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get('tab'))?.key ?? 'sync') as Tab;
  return (
    <section>
      <h2>배치 실행 이력</h2>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setParams({ tab: t.key })}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'sync' ? <SyncRuns /> : tab === 'van' ? <VanRuns /> : <WeeklyRuns />}
      <p className="muted">이상 단말기 찾기는 실행 기록을 따로 남기지 않습니다. 결과는 이상 단말기 화면에서 봅니다.</p>
    </section>
  );
}

function SyncRuns() {
  const [job, setJob] = useState('');
  const [outcome, setOutcome] = useState('');
  const list = useBeforeIdList<SyncRunView>('sync-runs', '/sync-runs', { job, outcome });
  return (
    <>
      <div className="filters">
        <select aria-label="큐" value={job} onChange={(e) => setJob(e.target.value)}>
          <option value="">큐 전체</option>
          <option value="track-bungae">track-bungae(번개택배)</option>
          <option value="track-neurimbo">track-neurimbo(느림보물류)</option>
        </select>
        <select aria-label="결과" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <option value="">결과 전체</option>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
      <ErrorBox error={list.error} />
      <table>
        <thead>
          <tr>
            <th scope="col">번호</th>
            <th scope="col">큐</th>
            <th scope="col">운송장</th>
            <th scope="col">시도</th>
            <th scope="col">결과</th>
            <th scope="col">받음/새로/중복</th>
            <th scope="col">시작</th>
            <th scope="col">워커</th>
            <th scope="col">내용</th>
          </tr>
        </thead>
        <tbody>
          {itemsOf(list.data).map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{r.job}</td>
              <td>{r.trackingNo ?? '-'}</td>
              <td>{r.attempt}</td>
              <td className={r.outcome === 'ERROR' ? 'bad' : undefined}>{r.outcome}</td>
              <td>
                {r.fetched}/{r.inserted}/{r.duplicated}
              </td>
              <td>{formatKst(r.startedAt)}</td>
              <td>{r.worker}</td>
              <td>{r.detail ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <MoreButton hasNextPage={list.hasNextPage} isFetchingNextPage={list.isFetchingNextPage} fetchNextPage={list.fetchNextPage} />
    </>
  );
}

function VanRuns() {
  const list = useBeforeIdList<VanRunView>('van-runs', '/van-reconciliations');
  return (
    <>
      <ErrorBox error={list.error} />
      <table>
        <thead>
          <tr>
            <th scope="col">번호</th>
            <th scope="col">상태</th>
            <th scope="col">시작</th>
            <th scope="col">끝</th>
            <th scope="col">요청</th>
            <th scope="col">어긋남</th>
          </tr>
        </thead>
        <tbody>
          {itemsOf(list.data).map((r) => (
            <tr key={r.id}>
              <td>
                <Link to={`/reports/van/${r.id}`}>#{r.id}</Link>
              </td>
              <td className={r.status === 'FAILED' ? 'bad' : undefined}>{r.status}</td>
              <td>{formatKst(r.startedAt)}</td>
              <td>{formatKst(r.finishedAt)}</td>
              <td>{r.trigger === 'SCHEDULED' ? '주기' : r.requestedBy}</td>
              <td>{r.confirmed}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <MoreButton hasNextPage={list.hasNextPage} isFetchingNextPage={list.isFetchingNextPage} fetchNextPage={list.fetchNextPage} />
    </>
  );
}

function WeeklyRuns() {
  const list = useInfiniteQuery({
    queryKey: ['weekly-reports'],
    queryFn: ({ pageParam }) => api<{ items: WeeklyReportView[]; nextBefore: string | null }>('/reports/weekly', { query: { before: pageParam ?? undefined } }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
  });
  return (
    <>
      <ErrorBox error={list.error} />
      <table>
        <thead>
          <tr>
            <th scope="col">주</th>
            <th scope="col">상태</th>
            <th scope="col">시도</th>
            <th scope="col">만든 시각</th>
            <th scope="col">보낸 시각</th>
            <th scope="col">마지막 오류</th>
          </tr>
        </thead>
        <tbody>
          {(list.data?.pages.flatMap((p) => p.items) ?? []).map((r) => {
            // 대기열에 있는 동안의 lastError는 지난 시도의 것이다 — 주간 리포트 화면과 같게 숨긴다
            const lastError = r.queued ? null : r.lastError;
            return (
              <tr key={r.weekStart}>
                <td>
                  <Link to="/reports/weekly">{r.weekStart}</Link>
                </td>
                <td>
                  {r.status}
                  {r.queued ? <span className="badge">대기열</span> : null}
                </td>
                <td>{r.attempts}</td>
                <td>{formatKst(r.generatedAt)}</td>
                <td>{formatKst(r.sentAt)}</td>
                <td className={lastError ? 'bad' : undefined}>{lastError ?? ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <MoreButton hasNextPage={list.hasNextPage} isFetchingNextPage={list.isFetchingNextPage} fetchNextPage={list.fetchNextPage} />
    </>
  );
}
