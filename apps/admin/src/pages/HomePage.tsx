import { useId, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import type { DashboardView } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { useNow } from '../hooks/useNow';
import { ageText, formatKst } from '../lib/format';
import { label, TERMINAL_STATUS_LABEL } from '../lib/labels';

/** 카드 하나(제목이 영역 이름 — 화면 읽기 도구와 테스트가 이름으로 찾는다) */
function Card({ title, children }: { title: string; children: ReactNode }) {
  const id = useId(); // 제목에 공백이 있어 aria-labelledby용 id로 쓰지 않는다(공백이 id 목록 구분자)
  return (
    <section className="card" aria-labelledby={id}>
      <h4 id={id}>{title}</h4>
      {children}
    </section>
  );
}

/** 운영 현황 카드들. 숫자는 서버가 집계한 값 그대로(화면은 세지 않는다) */
function Dashboard({ data }: { data: DashboardView }) {
  const { terminals, connectivity, anomalies, van } = data;
  return (
    <div className="cards">
      <Card title="단말기">
        <p className="big">{terminals.total}대</p>
        <ul className="plain">
          {terminals.byStatus.map((s) => (
            <li key={s.status}>
              {label(TERMINAL_STATUS_LABEL, s.status)} {s.count}
            </li>
          ))}
        </ul>
        <p className="muted">{terminals.byModel.map((m) => `${m.modelCode} ${m.count}`).join(' · ')}</p>
        <Link to="/terminals">단말기 목록</Link>
      </Card>
      <Card title="접속 상태">
        <p className="big">운영 중 {connectivity.inService}대</p>
        <p>
          온라인 {connectivity.online} · 오프라인 {connectivity.offline} · 기록 없음 {connectivity.noRecord}
        </p>
      </Card>
      <Card title="열린 이상">
        <p className="big">{anomalies.open}건</p>
        <ul className="plain">
          {anomalies.byRule.map((r) => (
            <li key={r.rule}>
              {r.label} {r.open}
            </li>
          ))}
        </ul>
        <Link to="/reports/anomalies">이상 단말기 보기</Link>
      </Card>
      <Card title="진행 중 배포">
        <p className="big">{data.rollouts.active}건</p>
        <Link to="/firmware-rollouts">펌웨어 배포 보기</Link>
      </Card>
      <Card title="열린 A/S">
        <p className="big">{data.serviceTickets.open}건</p>
        <Link to="/service-tickets">A/S 보기</Link>
      </Card>
      <Card title="최근 VAN 대조">
        {van ? (
          <>
            <p className="big">어긋남 {van.confirmed}건</p>
            <p>
              <Link to={`/reports/van/${van.runId}`} aria-label={`VAN 대조 #${van.runId} 상세`}>#{van.runId}</Link> {formatKst(van.finishedAt)} 끝
            </p>
          </>
        ) : (
          <p>없음</p>
        )}
      </Card>
      <Card title="이번 주 전이">
        <p className="big">{data.week.transitions}건</p>
        <p className="muted">{data.week.weekStart}(월)부터</p>
      </Card>
    </div>
  );
}

/**
 * 처음 화면: 운영 현황(GET /dashboard/summary)과 api 연결 확인(GET /health).
 * 서버는 집계를 짧게(기본 30초) 캐시한다 — 화면은 집계 시각(cachedAt)과 "N초 전"을 함께 보여 주고, 새로고침은 refresh=true로
 * 캐시를 건너뛴 새 집계를 받아 그대로 보여 준다(읽기 결과라 무효화 대신 캐시에 넣는다, api decisions/0044).
 */
export function HomePage() {
  const client = useQueryClient();
  const health = useQuery({ queryKey: keys.health, queryFn: () => api<{ status: string }>('/health') });
  const dashboard = useQuery({ queryKey: keys.dashboard, queryFn: () => api<DashboardView>('/dashboard/summary') });
  const refresh = useMutation({
    onMutate: () => client.cancelQueries({ queryKey: keys.dashboard }), // 진행 중인 옛 조회가 새 집계를 덮어쓰지 않게
    mutationFn: () => api<DashboardView>('/dashboard/summary', { query: { refresh: 'true' } }),
    onSuccess: (data) => client.setQueryData(keys.dashboard, data),
    // 첫 조회 중이던 것을 취소했는데 새로고침마저 실패하면 데이터가 없는 채 멈추니, 다시 조회한다
    onError: () => client.invalidateQueries({ queryKey: keys.dashboard }),
  });
  const data = dashboard.data;
  const now = useNow(5000);
  return (
    <section>
      <h2>처음</h2>
      <div className="row">
        <h3>운영 현황</h3>
        {data ? (
          <span className="muted">
            <time dateTime={data.cachedAt}>{formatKst(data.cachedAt)}</time> 기준 ({ageText(data.cachedAt, now)})
          </span>
        ) : null}
        <button type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          {refresh.isPending ? '새로고침 중' : '새로고침'}
        </button>
      </div>
      <ErrorBox error={dashboard.error} />
      <ErrorBox error={refresh.error} />
      {dashboard.isPending ? <p role="status">불러오는 중</p> : data ? <Dashboard data={data} /> : null}
      <p>
        api 연결:{' '}
        {health.isPending ? '확인 중' : health.isError ? '실패' : <strong className="ok">{health.data.status}</strong>}
      </p>
      <ErrorBox error={health.error} />
      <ul className="hint">
        <li>시각은 모두 한국 시간(KST)으로 보여 줍니다.</li>
        <li>운영 현황 숫자는 서버가 잠시 재사용하는 집계입니다(기본 30초). 바로 보려면 새로고침을 누르세요.</li>
        <li>바꾸는 작업(전이·스캔·A/S 등)은 위쪽에 작업자 이름을 저장해야 할 수 있습니다. 이름은 이력에 남습니다.</li>
      </ul>
    </section>
  );
}
