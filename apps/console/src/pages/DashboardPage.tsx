import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { OpsDependencyView, OpsOutboxView, OpsQueuesView, OpsRequeueResult, OpsSystemView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { canOperate } from '../components/AuthGate';
import { ErrorBox } from '../components/ErrorBox';
import { Freshness } from '../components/Freshness';
import { agoText, formatKst } from '../lib/format';
import { useRefetchInterval } from '../lib/refresh';
import { useMe } from '../session';

/** 시각과 "N분 전"을 한 칸에. 없으면 '-' */
export function When({ iso, now }: { iso: string | null; now: Date }) {
  if (!iso) return <>-</>;
  return (
    <span title={iso}>
      {formatKst(iso)} <small className="muted">({agoText(iso, now)})</small>
    </span>
  );
}

function Dependency({ name, dep }: { name: string; dep: OpsDependencyView }) {
  return (
    <div className={dep.ok ? 'card' : 'card down'}>
      <h3>{name}</h3>
      {dep.ok ? <span className="badge ok">정상</span> : <span className="badge bad">응답 없음</span>}{' '}
      <span className="big">{dep.latencyMs === null ? '' : `${dep.latencyMs}ms`}</span>
      {dep.error ? <pre>{dep.error}</pre> : null}
    </div>
  );
}

function SystemCards({ system, now }: { system: OpsSystemView; now: Date }) {
  const names = [...new Set(system.workers.map((w) => w.name ?? '(이름 없음)'))];
  return (
    <div className="cards">
      <div className="card">
        <h3>api</h3>
        <span className="big">{system.api.version}</span>
        <div className="muted">
          기동 <When iso={system.api.startedAt} now={now} />
        </div>
        <div className="muted">
          node {system.api.node} · 큐 접두사 {system.api.queuePrefix}
        </div>
      </div>
      <Dependency name="MySQL" dep={system.mysql} />
      <Dependency name="Redis" dep={system.redis} />
      <div className="card">
        <h3>워커 프로세스</h3>
        {/* Redis를 못 읽으면 api는 워커를 빈 목록으로 준다(Task 1 리뷰 반영) — 그때 0은 "워커 없음"이 아니라 "모름" */}
        {names.length === 0 && !system.redis.ok ? (
          <>
            <span className="big">?</span>
            <div className="badge warn">워커 목록을 읽지 못함 — Redis 응답 없음</div>
          </>
        ) : (
          <>
            <span className="big">{names.length}</span>
            {names.length === 0 ? <div className="badge bad">큐를 처리하는 워커가 없습니다</div> : <div className="muted">{names.join(', ')}</div>}
          </>
        )}
      </div>
    </div>
  );
}

/** 0인 칸은 흐리게(decisions/0079 — 문제 있는 칸이 묻히지 않게) */
const num = (value: number | null, alert = false) => ['num', alert ? 'alert' : '', value === 0 ? 'zero' : ''].filter(Boolean).join(' ');

/** 큐 줄에 문제가 있나: 워커 0, 남은 실패, 최근 실패, 멈춤 */
const troubled = (q: OpsQueuesView['queues'][number]) => q.workers === 0 || q.counts.failed > 0 || (q.failedRecent ?? 0) > 0 || q.paused;

/**
 * 주의(decisions/0079): 큐 표·상태 카드의 값에서 화면이 고른다(새 API 없음) — 워커 0인 큐, 남은 실패(없으면 최근 실패)가 있는 큐, 멈춘 큐, 응답 없는 MySQL·Redis.
 * 큐 표에서 빨간 띠가 붙는 줄(troubled)과 같은 기준이다.
 * 없으면 그리지 않는다. 경고·상태 역할(alert·status)은 쓰지 않는다 — 오류 칸·마지막 갱신과 섞이지 않게, 이름 붙은 영역으로.
 */
function Warnings({ queues, system }: { queues?: OpsQueuesView; system?: OpsSystemView }) {
  const items: { key: string; text: string }[] = [];
  if (system && !system.mysql.ok) items.push({ key: 'mysql', text: 'MySQL 응답 없음' });
  if (system && !system.redis.ok) items.push({ key: 'redis', text: 'Redis 응답 없음' });
  for (const q of queues?.queues ?? []) {
    if (q.workers === 0) items.push({ key: `${q.name}-w`, text: `${q.name} 큐를 처리하는 워커 없음` });
    if (q.counts.failed > 0) items.push({ key: `${q.name}-f`, text: `${q.name} 실패 ${q.counts.failed}건 남음` });
    else if ((q.failedRecent ?? 0) > 0) items.push({ key: `${q.name}-r`, text: `${q.name} 최근 실패 ${q.failedRecent}건` });
    if (q.paused) items.push({ key: `${q.name}-p`, text: `${q.name} 큐 멈춤` });
  }
  if (items.length === 0) return null;
  return (
    <section className="warnings" aria-label="주의">
      <strong>주의 {items.length}</strong>
      <ul>
        {items.map((i) => (
          <li key={i.key}>{i.text}</li>
        ))}
      </ul>
      {queues?.queues.some((q) => q.counts.failed > 0) ? <Link to="/failed">실패 job 보기 →</Link> : null}
    </section>
  );
}

function QueueTable({ data, now }: { data: OpsQueuesView; now: Date }) {
  const most = Math.max(1, ...data.queues.map((q) => q.completedRecent ?? 0));
  return (
    <table className="queues">
      <thead>
        <tr>
          <th>큐</th>
          <th className="num">대기</th>
          <th className="num">처리 중</th>
          <th className="num">지연</th>
          <th className="num">실패(남은 것)</th>
          <th className="num">최근 {data.recentMinutes}분 완료</th>
          <th className="num">최근 {data.recentMinutes}분 실패</th>
          <th>가장 오래 기다린 job</th>
          <th className="num">워커</th>
        </tr>
      </thead>
      <tbody>
        {data.queues.map((q) => (
          <tr key={q.name} className={troubled(q) ? 'troubled' : undefined}>
            <td className="queue-name">
              {q.name} {q.paused ? <span className="badge warn">멈춤</span> : null}
            </td>
            <td className={num(q.counts.waiting + q.counts.prioritized)}>{q.counts.waiting + q.counts.prioritized}</td>
            <td className={num(q.counts.active)}>{q.counts.active}</td>
            <td className={num(q.counts.delayed)}>{q.counts.delayed}</td>
            <td className={num(q.counts.failed, q.counts.failed > 0)}>
              {q.counts.failed > 0 ? <Link to={`/failed?queue=${q.name}`}>{q.counts.failed}</Link> : 0}
            </td>
            <td className={num(q.completedRecent)}>
              {/* 처리량 막대(장식 — 수는 옆 글자) */}
              <span className="thru" aria-hidden="true" style={{ width: `${Math.round(((q.completedRecent ?? 0) / most) * 80)}px` }} />
              {q.completedRecent ?? '-'}
            </td>
            <td className={num(q.failedRecent, Boolean(q.failedRecent))}>{q.failedRecent ?? '-'}</td>
            <td className={q.oldestWaitingAt ? undefined : 'zero'}>
              <When iso={q.oldestWaitingAt} now={now} />
            </td>
            <td className={num(q.workers, q.workers === 0)}>{q.workers}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const OUTBOX_LABEL = { PENDING: '대기(PENDING)', QUEUED: '큐에 넣음(QUEUED)', SENT: '보냄(SENT)', FAILED: '실패(FAILED)' } as const;

function OutboxCards({ outbox, now }: { outbox: OpsOutboxView; now: Date }) {
  return (
    <>
      <div className="cards">
        {(Object.keys(OUTBOX_LABEL) as (keyof typeof OUTBOX_LABEL)[]).map((s) => (
          <div className="card" key={s}>
            <h3>{OUTBOX_LABEL[s]}</h3>
            <span className="big">{outbox.counts[s]}</span>
          </div>
        ))}
      </div>
      <p>
        가장 오래된 PENDING: <When iso={outbox.oldestPendingAt} now={now} /> · 가장 오래된 QUEUED: <When iso={outbox.oldestQueuedAt} now={now} />
      </p>
    </>
  );
}

/**
 * 멈춘 QUEUED 복구 sweep 지금 한 번(관제만, 확인창 뒤 — decisions/0042·0073). 주기 작업 outbox-requeue와 같은 일이라 눌러도 해롭지 않다
 * (job이 살아 있는 행은 건너뛴다). 끝나면 Outbox 요약·작업 기록을 다시 읽는다.
 */
function RequeueButton({ afterMs }: { afterMs: number }) {
  const client = useQueryClient();
  const [result, setResult] = useState<OpsRequeueResult | null>(null);
  const requeue = useMutation({
    mutationFn: () => api<OpsRequeueResult>('/ops/outbox/requeue', { method: 'POST' }),
    onSuccess: (r) => {
      setResult(r);
      void client.invalidateQueries({ queryKey: keys.outbox });
      void client.invalidateQueries({ queryKey: keys.actions });
    },
  });
  const run = () => {
    if (!window.confirm(`만든 지 ${afterMs / 1000}초 지난 QUEUED 알림 중 큐에 job이 없는 것을 다시 넣을까요? (주기 작업 outbox-requeue와 같은 일)`)) return;
    setResult(null);
    requeue.mutate();
  };
  return (
    <>
      <div className="toolbar">
        <button type="button" className="primary" disabled={requeue.isPending} onClick={run}>
          멈춘 QUEUED 복구 sweep 지금 실행
        </button>
      </div>
      {result ? (
        <p className="notice" role="status">
          QUEUED {result.checked}건을 보고 {result.requeued.length}건을 다시 넣었습니다{result.requeued.length > 0 ? `(#${result.requeued.join(', #')})` : ''}. 작업 기록 #{result.actionId}
        </p>
      ) : null}
      <ErrorBox error={requeue.error} />
    </>
  );
}

/**
 * 대시보드(보강 6): 프로세스·의존 상태 카드, 큐 표(실패 수는 실패 job 화면으로 가는 링크), Outbox 카드.
 * 세 쿼리 모두 자동 새로고침(decisions/0076). "N분 전"은 다시 읽을 때마다 지금 시각으로 다시 센다. 관제는 Outbox 복구 sweep을 여기서 돌린다.
 * 마지막 갱신은 세 쿼리 중 가장 최근 값, 오류는 쿼리마다 그 칸 아래에(Task 2·3 리뷰 반영 — 앞의 하나만 보이면 나머지 칸이 멈춘 것을 모른다).
 * 칸마다의 "멈춘 시각"까지는 보이지 않는다 — 오류가 있는 칸은 그 값이 마지막 갱신보다 오래됐을 수 있다.
 */
export function DashboardPage() {
  const me = useMe();
  const refetchInterval = useRefetchInterval();
  const system = useQuery({ queryKey: keys.system, queryFn: () => api<OpsSystemView>('/ops/system'), refetchInterval });
  const queues = useQuery({ queryKey: keys.queues, queryFn: () => api<OpsQueuesView>('/ops/queues'), refetchInterval });
  const outbox = useQuery({ queryKey: keys.outbox, queryFn: () => api<OpsOutboxView>('/ops/outbox'), refetchInterval });
  const updatedAt = Math.max(system.dataUpdatedAt, queues.dataUpdatedAt, outbox.dataUpdatedAt);
  const now = new Date(updatedAt || Date.now());

  return (
    <>
      <h1>대시보드</h1>
      <Freshness updatedAt={updatedAt} fetching={system.isFetching || queues.isFetching || outbox.isFetching} error={null} />
      <Warnings queues={queues.data} system={system.data} />

      <h2>프로세스·의존 상태</h2>
      <ErrorBox error={system.error} />
      {system.data ? <SystemCards system={system.data} now={now} /> : null}

      <h2>큐</h2>
      <ErrorBox error={queues.error} />
      {queues.data ? <QueueTable data={queues.data} now={now} /> : null}

      <h2>Outbox(알림)</h2>
      <ErrorBox error={outbox.error} />
      {outbox.data ? <OutboxCards outbox={outbox.data} now={now} /> : null}
      {outbox.data && canOperate(me?.role) ? <RequeueButton afterMs={outbox.data.requeueAfterMs} /> : null}
    </>
  );
}
