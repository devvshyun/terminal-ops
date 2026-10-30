import { useQuery } from '@tanstack/react-query';
import type { BeforeIdPage, RolloutView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { ErrorBox } from '../components/ErrorBox';
import { Open, Run, Step } from '../components/Step';
import { setFirmwareFailRate, startRollout } from '../lib/demo-actions';
import { pct, ROLLOUT_STATUS } from '../lib/labels';
import { call } from '../lib/servers';

const POLL_MS = 3000;
const MODEL = 'SN-100';

function RolloutPanel({ rollout }: { rollout: RolloutView | undefined }) {
  if (!rollout) return <p className="muted">아직 {MODEL} 배포가 없습니다.</p>;
  return (
    <>
      <p className="big">{rollout.modelCode} {rollout.version} · {ROLLOUT_STATUS[rollout.status]}</p>
      {rollout.endReason ? <p>{rollout.endReason}</p> : null}
      <table aria-label="배포 단계">
        <thead><tr><th scope="col">단계</th><th scope="col" className="num">대상</th><th scope="col" className="num">성공</th><th scope="col" className="num">실패</th></tr></thead>
        <tbody>
          {rollout.stageStats.map((s) => (
            <tr key={s.stage} className={s.stage === rollout.currentStage && rollout.status === 'RUNNING' ? 'current' : undefined}>
              <td>{s.stage + 1}단계 {s.percent}%</td><td className="num">{s.targets}</td><td className="num">{s.succeeded}</td><td className="num">{s.failed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** 막 6 펌웨어 배포와 자동 중단: 정상 배포 → 실패율 60% → 다시 배포 → 첫 단계에서 자동 중단 → 되돌리기 */
export function Act6() {
  const rollouts = useQuery({ queryKey: keys.rollouts, queryFn: () => api<BeforeIdPage<RolloutView>>('/firmware-rollouts', { query: { limit: 10 } }), refetchInterval: POLL_MS });
  const sim = useQuery({ queryKey: keys.simConfig, queryFn: () => call<{ firmwareFailRate: number }>('sim', '/__admin/config') });
  const latest = rollouts.data?.items.filter((r) => r.modelCode === MODEL).sort((a, b) => b.id - a.id)[0];
  const deploy = <Run label={`${MODEL} 새 버전 배포`} stepKey="6-ok" onRun={async () => { const r = await startRollout(MODEL); return `${r.version} 배포 시작`; }} />;
  const failLine = sim.data ? <p className="big">지금 펌웨어 실패율: {pct(sim.data.firmwareFailRate)}</p> : null;
  return (
    <>
      <Step stepKey="6-ok" n="6-1" title="정상 배포" who="운영자 · 단말기" actions={<>{deploy}<Open app="admin" path="/firmware-rollouts" label="펌웨어 배포 열기" /></>}
        result={<><ErrorBox error={rollouts.error} /><RolloutPanel rollout={latest} /></>}
      >
        <p>쓰지 않은 다음 버전을 등록하고 10% → 50% → 100%로 나눠 배포합니다. 단말기(시뮬레이터)가 하트비트 응답으로 지시를 받아 결과를 보고하면 단계가 넘어갑니다. 30초쯤이면 "완료"입니다.</p>
      </Step>
      <Step stepKey="6-fail-on" n="6-2" title="장애 켜기: 실패율 60%" who="시연자 · 시뮬레이터" actions={<Run label="펌웨어 실패율 60%" stepKey="6-fail-on" needsLogin={false} onRun={() => setFirmwareFailRate(0.6)} />}
        result={<><ErrorBox error={sim.error} />{failLine}</>}
      >
        <p>시뮬레이터 단말기가 업데이트를 60% 확률로 실패로 보고하게 합니다.</p>
      </Step>
      <Step stepKey="6-abort" n="6-3" title="다시 배포 → 자동 중단" who="운영자 · 시스템"
        actions={<Run label={`${MODEL} 새 버전 배포`} stepKey="6-abort" onRun={async () => { const r = await startRollout(MODEL); return `${r.version} 배포 시작`; }} />}
        result={<RolloutPanel rollout={latest} />}
      >
        <p>또 다른 새 버전을 배포합니다. 어느 단계든 실패율이 기준(20%)을 넘으면 다음 단계로 가지 않고 스스로 중단합니다 — 실패는 그 단계 대상에서 멈춥니다. 대상이 몇 대뿐인 첫 단계는 보고가 다 모이면 판단하므로, 실패가 늦게 나오면 둘째 단계에서 멈추기도 합니다(확률이라 실행마다 다르다). 6-1 배포가 아직 진행 중이면 끝난 뒤에 실행하세요.</p>
      </Step>
      <Step stepKey="6-fail-off" n="6-4" title="되돌리기: 0%" who="시연자" actions={<Run label="펌웨어 실패율 0%" stepKey="6-fail-off" needsLogin={false} onRun={() => setFirmwareFailRate(0)} />} result={failLine}>
        <p>다음 시연을 위해 실패율을 0으로 되돌립니다.</p>
      </Step>
    </>
  );
}
