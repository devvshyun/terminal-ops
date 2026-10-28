import { Link } from 'react-router';
import { RECENT_TICKETS, useMyTickets } from '../api/queries';
import { ErrorBox } from '../components/ErrorBox';
import { currentStep } from '../components/StepList';
import { formatKstShort } from '../lib/format';
import { TICKET_STATUS_LABEL } from '../lib/labels';
import { ticketSteps } from '../lib/steps';

/** A/S 목록(최근 50건, 최근 것 위). 진행 중인 것은 지금 단계를 함께 보인다. 위에 고장 접수 */
export function ServiceTicketsPage() {
  const tickets = useMyTickets();
  return (
    <>
      <h1>A/S</h1>
      <Link className="card" to="/service-tickets/new">
        <strong>고장 접수하기</strong>
        <div className="muted">사용 중인 단말기가 고장 났을 때</div>
      </Link>
      {tickets.error ? <ErrorBox error={tickets.error} /> : null}
      {!tickets.data && !tickets.error ? <p>불러오는 중…</p> : null}
      {tickets.data && tickets.data.items.length === 0 ? <p className="muted">A/S 접수가 없습니다.</p> : null}
      {(tickets.data?.items ?? []).map((t) => (
        <Link key={t.id} className="card" to={`/service-tickets/${t.id}`}>
          <div className="card-head">
            <strong>A/S #{t.id}</strong>
            <span className={`badge ${t.status === 'OPEN' || t.status === 'REPLACING' ? 'warn' : 'ok'}`}>{TICKET_STATUS_LABEL[t.status]}</span>
          </div>
          <div className="muted">
            {formatKstShort(t.createdAt)} · {t.serialNo}
          </div>
          <div>{t.symptom}</div>
          {t.status === 'OPEN' || t.status === 'REPLACING' ? <div>지금 단계: {currentStep(ticketSteps(t))}</div> : null}
        </Link>
      ))}
      {tickets.data?.nextBeforeId ? <p className="muted">최근 {RECENT_TICKETS}건만 보입니다. 지난 접수는 본사에 문의하세요.</p> : null}
    </>
  );
}
