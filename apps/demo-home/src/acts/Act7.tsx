import { useQuery } from '@tanstack/react-query';
import type { ConnectivityView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { ErrorBox } from '../components/ErrorBox';
import { Open, Run, Step } from '../components/Step';
import { setDeviceOffline } from '../lib/demo-actions';
import { formatKst } from '../lib/format';
import { call } from '../lib/servers';

const POLL_MS = 5000;
/** 시연 데이터 역삼카페 단말기(시연 단계가 쓰는 한 대, docs/demo.md 11번과 같다) */
const SERIAL = 'DM-0005';

interface ToktokBox {
  messages: { idempotencyKey: string; text: string; receivedAt: string }[];
}

/** 막 7 단말기가 끊긴다: 끄기 → 90초 뒤 오프라인 판정·메신저 알림 → 켜기 */
export function Act7() {
  const connectivity = useQuery({ queryKey: keys.connectivity(SERIAL), queryFn: () => api<ConnectivityView>(`/terminals/${SERIAL}/connectivity`), refetchInterval: POLL_MS });
  const toktok = useQuery({ queryKey: keys.toktok, queryFn: () => call<ToktokBox>('partners', '/__admin/toktok/messages'), refetchInterval: POLL_MS });
  const mine = (toktok.data?.messages ?? []).filter((m) => m.text.includes(SERIAL) && /오프라인|온라인/.test(m.text)).slice(-3).reverse();
  const c = connectivity.data;
  return (
    <>
      <Step stepKey="7-off" n="7-1" title="단말기 끄기" who="시연자 · 시뮬레이터" actions={<Run label={`${SERIAL} 끄기`} stepKey="7-off" needsLogin={false} onRun={() => setDeviceOffline(SERIAL, true)} />}>
        <p>시뮬레이터에서 역삼카페 단말기 {SERIAL}의 하트비트를 멈춥니다(전원이 나간 것처럼).</p>
      </Step>
      <Step stepKey="7-wait" n="7-2" title="오프라인 판정과 알림" who="시스템" actions={<Open app="admin" path={`/terminals/${SERIAL}`} label="단말기 상세 열기" />}
        result={
          <>
            <ErrorBox error={connectivity.error ?? toktok.error} />
            {c ? <p className="big">{SERIAL} · {c.online ? '온라인' : '오프라인'}</p> : null}
            {c?.lastSeenAt ? <small className="muted">마지막 하트비트 {formatKst(c.lastSeenAt)}</small> : null}
            <ul className="rows">
              {mine.map((m) => (
                <li key={`${m.idempotencyKey}-${m.receivedAt}`}>{m.text}</li>
              ))}
            </ul>
          </>
        }
      >
        <p>하트비트가 90초 끊기면 10초마다 도는 판정이 오프라인으로 바꾸고, 메신저(톡톡, 가상)로 알립니다. 아래에 그 메시지가 나타납니다.</p>
      </Step>
      <Step stepKey="7-on" n="7-3" title="되돌리기: 켜기" who="시연자" actions={<Run label={`${SERIAL} 켜기`} stepKey="7-on" needsLogin={false} onRun={() => setDeviceOffline(SERIAL, false)} />}>
        <p>다시 켜면 다음 하트비트에 온라인으로 돌아오고 "온라인" 알림이 갑니다.</p>
      </Step>
      <p className="muted">끝. 큐·워커는 <Open app="console" label="운영 관제" compact />, 외부 업체 키는 <Open app="developers" label="개발자센터" compact />에서 이어 볼 수 있습니다.</p>
    </>
  );
}
