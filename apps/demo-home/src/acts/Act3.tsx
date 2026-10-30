import { useQuery } from '@tanstack/react-query';
import type { BeforeIdPage, SyncRunView, TerminalView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { ErrorBox } from '../components/ErrorBox';
import { Open, Run, Step } from '../components/Step';
import { shipOne } from '../lib/demo-actions';
import { TERMINAL_STATUS } from '../lib/labels';
import { remember, useRecall } from '../lib/memo';

const POLL_MS = 5000;

/** 막 3 가맹점까지: 재고 한 대 → 강남김밥 배정 → 번개택배 출고 → 워커의 택배 수집이 배송 완료로 → 점주 홈 */
export function Act3() {
  const serial = useRecall('act3-serial');
  const tracking = useRecall('act3-tracking');
  const terminal = useQuery({ queryKey: keys.terminal(serial ?? ''), queryFn: () => api<TerminalView>(`/terminals/${serial}`), enabled: serial !== null, refetchInterval: POLL_MS });
  const runs = useQuery({ queryKey: keys.syncRuns({ limit: 20 }), queryFn: () => api<BeforeIdPage<SyncRunView>>('/sync-runs', { query: { limit: 20 } }), enabled: tracking !== null, refetchInterval: POLL_MS });
  const mine = runs.data?.items.filter((r) => r.trackingNo === tracking) ?? [];
  return (
    <>
      <Step
        stepKey="3-ship"
        n="3-1"
        title="배정하고 출고"
        who="운영자"
        actions={
          <Run
            label="재고 한 대를 강남김밥으로 출고"
            stepKey="3-ship"
            onRun={async () => {
              const r = await shipOne('GANGNAM-KIMBAP');
              remember('act3-serial', r.serialNo);
              remember('act3-tracking', r.trackingNo);
              return `${r.serialNo} · 운송장 ${r.trackingNo}`;
            }}
          />
        }
      >
        <p>재고 단말기 하나를 가맹점 강남김밥에 배정하고 번개택배(가상)로 보냅니다. 운송장은 택배사 API가 발급합니다. 재고가 없으면 시연용 재고를 하나 만듭니다(등록 → 검수 합격 → 재고).</p>
      </Step>
      <Step stepKey="3-track" n="3-2" title="배송 완료 기다리기" who="시스템(워커)" actions={<Open app="admin" path="/batch-runs" label="배치 실행 이력 열기" />}
        result={
          serial ? (
            <>
              <ErrorBox error={terminal.error} />
              {terminal.data ? <p className="big">{serial} · {TERMINAL_STATUS[terminal.data.status]}({terminal.data.status})</p> : null}
              <ul className="rows">
                {mine.slice(0, 5).map((r) => (
                  <li key={r.id}><span className="mono">{r.outcome}</span> · {r.attempt}번째 <small className="muted">{r.detail ?? ''}</small></li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted">3-1을 실행하면 그 단말기 상태를 5초마다 다시 읽습니다.</p>
          )
        }
      >
        <p>워커가 15초마다(시연 설정) 배송 중인 운송장을 택배사에 물어, 이벤트를 쌓고 배송 완료로 바꿉니다. 1~2분 걸립니다. 같은 이벤트가 두 번 와도 한 번만 반영합니다.</p>
      </Step>
      <Step stepKey="3-merchant" n="3-3" title="점주가 본다" who="가맹점주(merchant-gangnam) · 매장 화면" actions={<Open app="merchant" label="매장 화면 열기" />}>
        <p>매장 화면에 <code>merchant-gangnam</code>으로 로그인하면 "오고 있는 단말기"에 이 단말기와 택배 단계가 보입니다. 로그인은 화면마다 따로라 이 시연 홈은 운영자 그대로입니다.</p>
      </Step>
    </>
  );
}
