import { useQuery } from '@tanstack/react-query';
import type { AnomalyView, DashboardView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { ErrorBox } from '../components/ErrorBox';
import { Open, Step } from '../components/Step';
import { formatKst } from '../lib/format';

/** 막 1 한눈에: 어드민 처음 화면과 같은 숫자(대시보드), 열린 이상 단말기 */
export function Act1() {
  const summary = useQuery({ queryKey: keys.dashboard, queryFn: () => api<DashboardView>('/dashboard/summary') });
  const anomalies = useQuery({ queryKey: keys.anomalies, queryFn: () => api<{ items: AnomalyView[] }>('/anomalies', { query: { open: true, limit: 20 } }) });
  const s = summary.data;
  const van = s?.van ? Object.values(s.van.counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <>
      <Step stepKey="1-dashboard" n="1-1" title="처음 화면 숫자" who="운영자 · 어드민 처음 화면" actions={<Open app="admin" label="어드민 처음 화면 열기" />}
        result={
          <>
            <ErrorBox error={summary.error} />
            {s ? (
              <>
                <p className="big">
                  운영 중 {s.connectivity.inService} · 온라인 {s.connectivity.online} · 오프라인 {s.connectivity.offline}
                </p>
                <dl className="stats">
                  <div><dt>열린 이상</dt><dd>{s.anomalies.open}</dd></div>
                  <div><dt>VAN 어긋남</dt><dd>{van}</dd></div>
                  <div><dt>진행 중 배포</dt><dd>{s.rollouts.active}</dd></div>
                  <div><dt>열린 A/S</dt><dd>{s.serviceTickets.open}</dd></div>
                </dl>
                <small className="muted">집계 {formatKst(s.cachedAt)} · 최대 30초 재사용(어드민과 같은 값)</small>
              </>
            ) : null}
          </>
        }
      >
        <p>어드민 처음 화면의 "지금 볼 것"과 같은 숫자입니다. 시연 데이터를 띄운 직후 값은 시나리오 문서 1장 표와 같습니다.</p>
      </Step>
      <Step stepKey="1-anomalies" n="1-2" title="이상 단말기 두 대" who="운영자 · 어드민 이상 단말기" actions={<Open app="admin" path="/reports/anomalies" label="이상 단말기 열기" />}
        result={
          <>
            <ErrorBox error={anomalies.error} />
            {anomalies.data && anomalies.data.items.length === 0 ? <p className="empty">열린 이상이 없습니다.</p> : null}
            <ul className="rows">
              {anomalies.data?.items.map((a) => (
                <li key={a.id}>
                  <span className="mono strong">{a.serialNo ?? '-'}</span> {a.ruleLabel} <small className="muted">{formatKst(a.detectedAt)}부터</small>
                </li>
              ))}
            </ul>
          </>
        }
      >
        <p>며칠째 하트비트가 없는 단말기(장기 오프라인)와 배송 완료 뒤 설치되지 않은 단말기입니다. 매일 밤 도는 "이상 단말기 찾기"가 걸러 냅니다.</p>
      </Step>
    </>
  );
}
