import { useQuery } from '@tanstack/react-query';
import type { BeforeIdPage, TicketView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { ErrorBox } from '../components/ErrorBox';
import { Open, Run, Step } from '../components/Step';
import { replaceForTicket } from '../lib/demo-actions';
import { TICKET_STATUS } from '../lib/labels';
import { remember, useRecall } from '../lib/memo';

const POLL_MS = 5000;

const line = (t: TicketView) => `A/S #${t.id} · ${TICKET_STATUS[t.status]}${t.replacementSerialNo ? ` · 교체품 ${t.replacementSerialNo}` : ''}`;

/** 막 4 고장과 교체: 점주 접수 → 운영자 원격 점검(안 됨) → 교체 출고 → 점주 설치 확인 */
export function Act4() {
  const tickets = useQuery({ queryKey: keys.tickets, queryFn: () => api<BeforeIdPage<TicketView>>('/service-tickets', { query: { limit: 20 } }), refetchInterval: POLL_MS });
  const items = tickets.data?.items ?? [];
  const latestOpen = items.filter((t) => t.status === 'OPEN').sort((a, b) => b.id - a.id)[0] ?? null;
  const replacedId = Number(useRecall('act4-ticket')) || null;
  const replaced = items.find((t) => t.id === replacedId) ?? null;
  return (
    <>
      <Step stepKey="4-open" n="4-1" title="점주가 고장 접수" who="가맹점주(merchant-gangnam) · 매장 화면" actions={<Open app="merchant" label="매장 화면 열기" />}
        result={
          <>
            <ErrorBox error={tickets.error} />
            <ul className="rows">
              {items.filter((t) => t.status === 'OPEN' || t.status === 'REPLACING').map((t) => (
                <li key={t.id}><span className="mono strong">{t.serialNo}</span> {line(t)} <small className="muted">{t.symptom}</small></li>
              ))}
            </ul>
          </>
        }
      >
        <p>매장 화면에 <code>merchant-gangnam</code>으로 로그인 → 단말기 <code>DM-0004</code> → "고장 접수". 접수 목록을 5초마다 다시 읽습니다(강남김밥 DM-0001은 시연 데이터의 A/S #1).</p>
      </Step>
      <Step
        stepKey="4-replace"
        n="4-2"
        title="원격 점검 → 교체 출고"
        who="운영자"
        actions={
          latestOpen ? (
            <Run label={`A/S #${latestOpen.id} 원격 점검 → 교체 출고`} stepKey="4-replace" onRun={async () => { const t = await replaceForTicket(latestOpen.id); remember('act4-ticket', String(t.id)); }} />
          ) : (
            <small className="muted">열린 접수가 없습니다 — 4-1에서 접수하세요.</small>
          )
        }
        result={replaced ? <p className="big">{line(replaced)}</p> : null}
      >
        <p>원격으로 점검해도 안 되면 재고 한 대를 교체품으로 보냅니다. 교체품 출고와 고장 단말기 회수 요청이 한 트랜잭션으로 묶입니다(하나라도 실패하면 모두 그대로).</p>
      </Step>
      <Step stepKey="4-install" n="4-3" title="점주가 설치 확인" who="가맹점주 · 매장 화면" actions={<Open app="merchant" label="매장 화면 열기" />}
        result={replaced ? <p>{line(replaced)}</p> : <p className="muted">4-2를 실행하면 그 접수 상태를 다시 읽습니다.</p>}
      >
        <p>교체품이 배송 완료되면(1~2분) 매장 화면의 A/S 진행 단계에 "설치 확인" 단추가 생깁니다. 누르면 접수가 끝나고 교체품이 운영 중이 됩니다.</p>
      </Step>
    </>
  );
}
