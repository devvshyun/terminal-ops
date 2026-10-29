import { useId, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import type { DashboardView } from '@terminal-ops/contracts';
import { ErrorBox } from '../components/ErrorBox';
import { useNow } from '../hooks/useNow';
import { ageText, formatKst } from '../lib/format';
import { label, STAGES, STATUS_STAGE, TERMINAL_STATUS_LABEL } from '../lib/labels';

/** 카드 하나(제목이 영역 이름 — 화면 읽기 도구와 테스트가 이름으로 찾는다) */
function Card({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  const id = useId(); // 제목에 공백이 있어 aria-labelledby용 id로 쓰지 않는다(공백이 id 목록 구분자)
  return (
    <section className={className ? `card ${className}` : 'card'} aria-labelledby={id}>
      <h4 id={id}>{title}</h4>
      {children}
    </section>
  );
}

/** 비율 막대(장식 — 같은 수가 글자로 옆에 있다). 0인 칸은 그리지 않는다 */
function Bar({ className, parts }: { className: string; parts: { key: string; value: number; fill: string }[] }) {
  return (
    <div className={className} aria-hidden="true">
      {parts
        .filter((p) => p.value > 0)
        .map((p) => (
          <span key={p.key} className={p.fill} style={{ flexGrow: p.value }} />
        ))}
    </div>
  );
}

/**
 * 지금 볼 것(decisions/0079): 오래 오프라인·배송 뒤 설치 안 됨(열린 이상의 규칙별 수)과 최근 VAN 대조의 어긋남. 새 집계 없이 같은 응답에서 고른다.
 * 0이면 초록 테두리로 "괜찮음"을 보인다. 이름은 서버가 주는 규칙 이름(label) 그대로
 */
const WATCHED_RULES = [
  { rule: 'OFFLINE_TOO_LONG', fallback: '오래 오프라인', tone: '' },
  { rule: 'DELIVERED_NOT_INSTALLED', fallback: '배송 뒤 설치 안 됨', tone: 'warn' },
] as const;

function Attention({ data }: { data: DashboardView }) {
  return (
    <section className="attention" aria-label="지금 볼 것">
      {WATCHED_RULES.map((w) => {
        const r = data.anomalies.byRule.find((x) => x.rule === w.rule);
        const n = r?.open ?? 0;
        return (
          <div key={w.rule} className={n === 0 ? 'calm' : w.tone}>
            <strong>{r?.label ?? w.fallback}</strong>
            <span className="count">
              {n}
              <small>대</small>
            </span>
            <Link to="/reports/anomalies">이상 단말기에서 보기 →</Link>
          </div>
        );
      })}
      <div className={data.van && data.van.confirmed > 0 ? 'warn' : 'calm'}>
        <strong>VAN 어긋남</strong>
        <span className="count">
          {data.van?.confirmed ?? 0}
          <small>건</small>
        </span>
        {data.van ? <Link to={`/reports/van/${data.van.runId}`}>대조 결과 보기 →</Link> : <span className="muted">대조 기록 없음</span>}
      </div>
    </section>
  );
}

/** 운영 현황 카드들. 숫자는 서버가 집계한 값 그대로(화면은 세지 않는다) */
function Dashboard({ data }: { data: DashboardView }) {
  const { terminals, connectivity, anomalies, van } = data;
  const byStage = STAGES.map((stage) => ({
    key: stage,
    value: terminals.byStatus.filter((s) => STATUS_STAGE[s.status] === stage).reduce((sum, s) => sum + s.count, 0),
    fill: `stage-fill-${stage}`,
  }));
  return (
    <>
      <Attention data={data} />
      <div className="cards">
        <Card title="단말기" className="wide">
          <p className="big">{terminals.total}대</p>
          <Bar className="life-bar" parts={byStage} />
          <ul className="plain life-legend">
            {terminals.byStatus.map((s) => (
              <li key={s.status} className={`stage-fill-${STATUS_STAGE[s.status]}`}>
                {label(TERMINAL_STATUS_LABEL, s.status)} {s.count}
              </li>
            ))}
          </ul>
          <p className="muted">{terminals.byModel.map((m) => `${m.modelCode} ${m.count}`).join(' · ')}</p>
          <Link to="/terminals">단말기 목록</Link>
        </Card>
        <Card title="접속 상태" className="half">
          <p className="big">운영 중 {connectivity.inService}대</p>
          <Bar
            className="conn-bar"
            parts={[
              { key: 'online', value: connectivity.online, fill: 'stage-fill-live' },
              { key: 'offline', value: connectivity.offline, fill: 'stage-fill-bad' },
              { key: 'none', value: connectivity.noRecord, fill: 'stage-fill-intake' },
            ]}
          />
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
    </>
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
        <li>바꾸는 작업(전이·스캔·A/S 등)은 역할에 따라 보이고, 이력에는 로그인 아이디가 남습니다.</li>
      </ul>
    </section>
  );
}
