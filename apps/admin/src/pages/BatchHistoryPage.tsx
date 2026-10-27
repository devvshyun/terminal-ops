import { Link, useSearchParams } from 'react-router';
import { itemsOf, useBeforeIdList, useWeeklyReports } from '../api/lists';
import { ErrorBox } from '../components/ErrorBox';
import { MoreButton } from '../components/MoreButton';
import { RunningPoller, type Refetch } from '../components/RunningPoller';
import { formatKst } from '../lib/format';
import type { VanRunView } from './reports/VanRunsPage';

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
 * 탭과 택배 수집 조건은 주소(?tab=&job=&outcome=)에 둔다. 탭을 바꾸면 조건은 버린다(조건은 택배 수집 탭에만 있다, decisions/0041 Task 9 보탬).
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
  const [params, setParams] = useSearchParams();
  const job = params.get('job') ?? '';
  const outcome = params.get('outcome') ?? '';
  const list = useBeforeIdList<SyncRunView>('sync-runs', '/sync-runs', { job, outcome });
  /** 조건 하나를 주소에 쓴다(빈 값이면 뺀다). 다른 조건과 탭은 그대로 */
  const setFilter = (key: 'job' | 'outcome', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };
  return (
    <>
      <div className="filters">
        <select aria-label="큐" value={job} onChange={(e) => setFilter('job', e.target.value)}>
          <option value="">큐 전체</option>
          <option value="track-bungae">track-bungae(번개택배)</option>
          <option value="track-neurimbo">track-neurimbo(느림보물류)</option>
        </select>
        <select aria-label="결과" value={outcome} onChange={(e) => setFilter('outcome', e.target.value)}>
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

/** 새로고침 버튼과, 진행 중(RUNNING·대기열)이면 2초 다시 읽기. 같은 캐시 키를 쓰는 VAN·주간 리포트 화면에서 넘어와도 낡은 상태가 남지 않게 */
function Refresh({ refetch, running, text }: { refetch: Refetch; running: boolean; text: string }) {
  return (
    <div className="filters">
      <button type="button" onClick={() => void refetch({ cancelRefetch: true })}>
        새로고침
      </button>
      {running ? <RunningPoller refetch={refetch} text={text} /> : null}
    </div>
  );
}

function VanRuns() {
  const list = useBeforeIdList<VanRunView>('van-runs', '/van-reconciliations');
  const runs = itemsOf(list.data);
  return (
    <>
      <Refresh refetch={list.refetch} running={runs.some((r) => r.status === 'RUNNING')} text="대조 진행 중" />
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
          {runs.map((r) => (
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
  const list = useWeeklyReports();
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <Refresh refetch={list.refetch} running={items.some((r) => r.queued)} text="보내는 중" />
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
          {items.map((r) => {
            // 대기열에 있는 동안의 lastError는 지난 시도의 것이다 — 주간 리포트 화면과 같게 숨긴다
            const lastError = r.queued ? null : r.lastError;
            return (
              <tr key={r.weekStart}>
                <td>
                  <Link to={`/reports/weekly?week=${r.weekStart}`}>{r.weekStart}</Link>
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
