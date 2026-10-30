import { useQuery } from '@tanstack/react-query';
import type { BeforeIdPage, SyncRunView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { ErrorBox } from '../components/ErrorBox';
import { Open, Run, Step } from '../components/Step';
import { setBungae429, shipOne } from '../lib/demo-actions';
import { codeClass, pct } from '../lib/labels';
import { call } from '../lib/servers';
import { formatKst } from '../lib/format';

const POLL_MS = 3000;

interface RequestRow {
  id: number;
  at: string;
  method: string;
  path: string;
  status: number;
}

function RunsList({ runs }: { runs: SyncRunView[] }) {
  return (
    <ul className="rows">
      {runs.map((r) => (
        <li key={r.id} className={r.outcome === 'ERROR' ? 'bad' : undefined}>
          <span className="mono strong">{r.outcome} · {r.attempt}번째</span> <span className="mono">{r.trackingNo ?? '-'}</span> <small className="muted">{r.detail ?? formatKst(r.startedAt)}</small>
        </li>
      ))}
    </ul>
  );
}

/** 막 5 택배사가 429를 낸다: 정상 → 429 켜기 → 출고 하나 → 재시도로 결국 받아 옴 → 되돌리기(장애 시연 묶음) */
export function Act5() {
  const config = useQuery({ queryKey: keys.partnersConfig, queryFn: () => call<{ bungae: { force429Rate: number } }>('partners', '/__admin/config') });
  const runs = useQuery({ queryKey: keys.syncRuns({ job: 'track-bungae', limit: 8 }), queryFn: () => api<BeforeIdPage<SyncRunView>>('/sync-runs', { query: { job: 'track-bungae', limit: 8 } }), refetchInterval: POLL_MS });
  const requests = useQuery({ queryKey: keys.partnerRequests, queryFn: () => call<{ items: RequestRow[] }>('partners', '/__admin/requests?limit=8&partner=bungae'), refetchInterval: POLL_MS });
  const rate = config.data?.bungae.force429Rate;
  const rateLine = rate === undefined ? null : <p className="big">지금 번개택배 429 확률: {pct(rate)}</p>;
  return (
    <>
      <Step stepKey="5-normal" n="5-1" title="정상: 최근 택배 수집" who="시스템(워커)" actions={<Open app="admin" path="/batch-runs" label="배치 실행 이력 열기" />}
        result={<><ErrorBox error={runs.error} /><RunsList runs={(runs.data?.items ?? []).slice(0, 4)} /></>}
      >
        <p>번개택배 추적 수집 기록입니다. 띄우고 1~2분 지나면 시연 데이터의 배송이 모두 끝나 새 기록이 없습니다. 5-3에서 새로 출고해야 추적 호출이 생깁니다.</p>
      </Step>
      <Step stepKey="5-on" n="5-2" title="장애 켜기: 429 50%" who="시연자 · 가상 업체" actions={<Run label="번개택배 429 확률 50%" stepKey="5-on" needsLogin={false} onRun={() => setBungae429(0.5)} />}
        result={<><ErrorBox error={config.error} />{rateLine}</>}
      >
        <p>번개택배(가상)가 추적 조회의 절반에 429(너무 많은 요청)와 <code>Retry-After</code>로 답하게 합니다.</p>
      </Step>
      <Step stepKey="5-ship" n="5-3" title="출고 하나 → 반응" who="운영자 · 시스템" actions={<Run label="재고 한 대를 번개택배로 출고" stepKey="5-ship" onRun={async () => { const r = await shipOne('YEOKSAM-CAFE'); return `${r.serialNo} · 운송장 ${r.trackingNo}`; }} />}
        result={
          <>
            <ErrorBox error={requests.error} />
            <ul className="rows">
              {(requests.data?.items ?? []).slice(0, 5).map((q) => (
                <li key={q.id}><span className={`code ${codeClass(q.status)}`}>{q.status === 0 ? '끊김' : q.status}</span> <span className="mono">{q.method} {q.path}</span></li>
              ))}
            </ul>
            <RunsList runs={(runs.data?.items ?? []).slice(0, 4)} />
          </>
        }
      >
        <p>다음 수집 주기(15초)부터 위는 번개택배가 받은 요청, 아래는 우리 수집 기록입니다. 429를 받은 수집은 ERROR로 남고, 큐가 <code>Retry-After</code>만큼 기다렸다 다시 시도해(2번째) 받아 옵니다.</p>
      </Step>
      <Step stepKey="5-off" n="5-4" title="되돌리기: 0%" who="시연자" actions={<Run label="번개택배 429 확률 0%" stepKey="5-off" needsLogin={false} onRun={() => setBungae429(0)} />} result={rateLine}>
        <p>시연 도구의 "모두 기본값으로"는 받은 데이터(운송장 등)까지 지웁니다. 여기서는 손잡이 하나만 0으로 되돌립니다.</p>
      </Step>
    </>
  );
}
