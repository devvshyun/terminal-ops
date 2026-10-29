import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { OpsDependencyView, OpsOutboxView, OpsQueuesView, OpsSystemView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { Freshness } from '../components/Freshness';
import { agoText, formatKst } from '../lib/format';
import { useRefetchInterval } from '../lib/refresh';

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
    <div className="card">
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
        <span className="big">{names.length}</span>
        {names.length === 0 ? <div className="badge bad">큐를 처리하는 워커가 없습니다</div> : <div className="muted">{names.join(', ')}</div>}
      </div>
    </div>
  );
}

function QueueTable({ data, now }: { data: OpsQueuesView; now: Date }) {
  return (
    <table>
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
          <tr key={q.name}>
            <td>
              {q.name} {q.paused ? <span className="badge warn">멈춤</span> : null}
            </td>
            <td className="num">{q.counts.waiting + q.counts.prioritized}</td>
            <td className="num">{q.counts.active}</td>
            <td className="num">{q.counts.delayed}</td>
            <td className={q.counts.failed > 0 ? 'num alert' : 'num'}>
              {q.counts.failed > 0 ? <Link to={`/failed?queue=${q.name}`}>{q.counts.failed}</Link> : 0}
            </td>
            <td className="num">{q.completedRecent ?? '-'}</td>
            <td className={q.failedRecent ? 'num alert' : 'num'}>{q.failedRecent ?? '-'}</td>
            <td>
              <When iso={q.oldestWaitingAt} now={now} />
            </td>
            <td className={q.workers === 0 ? 'num alert' : 'num'}>{q.workers}</td>
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
 * 대시보드(보강 6): 프로세스·의존 상태 카드, 큐 표(실패 수는 실패 job 화면으로 가는 링크), Outbox 카드.
 * 세 쿼리 모두 자동 새로고침(decisions/0076). "N분 전"은 다시 읽을 때마다 지금 시각으로 다시 센다.
 */
export function DashboardPage() {
  const refetchInterval = useRefetchInterval();
  const system = useQuery({ queryKey: keys.system, queryFn: () => api<OpsSystemView>('/ops/system'), refetchInterval });
  const queues = useQuery({ queryKey: keys.queues, queryFn: () => api<OpsQueuesView>('/ops/queues'), refetchInterval });
  const outbox = useQuery({ queryKey: keys.outbox, queryFn: () => api<OpsOutboxView>('/ops/outbox'), refetchInterval });
  const now = new Date(Math.max(system.dataUpdatedAt, queues.dataUpdatedAt, outbox.dataUpdatedAt) || Date.now());

  return (
    <>
      <h1>대시보드</h1>
      <Freshness updatedAt={queues.dataUpdatedAt} fetching={queues.isFetching} error={system.error ?? queues.error ?? outbox.error} />

      <h2>프로세스·의존 상태</h2>
      {system.data ? <SystemCards system={system.data} now={now} /> : null}

      <h2>큐</h2>
      {queues.data ? <QueueTable data={queues.data} now={now} /> : null}

      <h2>Outbox(알림)</h2>
      {outbox.data ? <OutboxCards outbox={outbox.data} now={now} /> : null}
    </>
  );
}
