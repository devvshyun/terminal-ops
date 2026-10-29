import { Link, useParams } from 'react-router';
import { useMyTerminal, useMyTickets } from '../api/queries';
import { ErrorBox } from '../components/ErrorBox';
import { StepList } from '../components/StepList';
import { ConnectivityLine, DeliveredHint, StatusBadge } from '../components/TerminalBits';
import { formatKst, formatKstShort } from '../lib/format';
import { CARRIER_LABEL, RETURN_GUIDE, TERMINAL_EVENT_LABEL, TICKET_STATUS_LABEL } from '../lib/labels';
import { shipmentSteps } from '../lib/steps';

/**
 * 단말기 상세: 지금 상태, 접속(사용 중일 때), 배송 단계(오고 있을 때), 회수 안내, 지난 일(이번 배정부터, 최근 것 위), 이 단말기의 A/S.
 * 고장 접수 버튼은 사용 중이고 열린 A/S가 없을 때만 — 서버도 같은 조건을 다시 본다(422 TERMINAL_NOT_IN_SERVICE, 409 TICKET_ALREADY_OPEN).
 */
export function TerminalDetailPage() {
  const serialNo = useParams().serialNo!;
  const detail = useMyTerminal(serialNo);
  const tickets = useMyTickets(serialNo);

  if (detail.error) return <ErrorBox error={detail.error} />;
  if (!detail.data) return <p>불러오는 중…</p>;
  const t = detail.data;
  const now = new Date(detail.dataUpdatedAt || Date.now());
  const hasOpenTicket = (tickets.data?.items ?? []).some((x) => x.status === 'OPEN' || x.status === 'REPLACING');

  return (
    <>
      <h1>{t.modelName}</h1>
      <p>
        <StatusBadge status={t.status} /> <span className="muted serial">{t.serialNo}</span>
      </p>

      {t.connectivity ? (
        <section aria-labelledby="h-conn">
          <h2 id="h-conn">연결</h2>
          <p>
            <ConnectivityLine c={t.connectivity} now={now} />
          </p>
          <dl className="facts">
            <dt>마지막 접속</dt>
            <dd>{formatKst(t.connectivity.lastSeenAt)}</dd>
            <dt>펌웨어</dt>
            <dd>{t.connectivity.firmwareVersion ?? '-'}</dd>
          </dl>
          {!t.connectivity.online && t.connectivity.lastSeenAt ? (
            <p className="notice">단말기 전원과 인터넷 선을 확인해 주세요. 계속 연결이 끊기면 고장 접수를 해 주세요.</p>
          ) : null}
        </section>
      ) : null}

      {t.shipment ? (
        <section aria-labelledby="h-ship">
          <h2 id="h-ship">배송</h2>
          <dl className="facts">
            <dt>택배사</dt>
            <dd>{CARRIER_LABEL[t.shipment.carrier]}</dd>
            <dt>운송장</dt>
            <dd className="serial">{t.shipment.trackingNo}</dd>
            {t.shipment.ticketId ? (
              <>
                <dt>A/S</dt>
                <dd>
                  <Link to={`/service-tickets/${t.shipment.ticketId}`}>#{t.shipment.ticketId} 교체 단말기</Link>
                </dd>
              </>
            ) : null}
          </dl>
          <StepList label="배송 단계" steps={shipmentSteps(t.shipment)} />
        </section>
      ) : null}

      <DeliveredHint t={t} />
      {RETURN_GUIDE[t.status] ? <p className="notice">{RETURN_GUIDE[t.status]}</p> : null}

      {t.status === 'IN_SERVICE' && tickets.data && !hasOpenTicket ? (
        <Link className="card" to={`/service-tickets/new?serialNo=${encodeURIComponent(t.serialNo)}`}>
          <strong>고장 접수하기</strong>
          <div className="muted">증상을 고르면 본사가 원격으로 먼저 점검합니다.</div>
        </Link>
      ) : null}

      <section aria-labelledby="h-tickets">
        <h2 id="h-tickets">이 단말기의 A/S</h2>
        {tickets.error ? <ErrorBox error={tickets.error} /> : null}
        {tickets.data && tickets.data.items.length === 0 ? <p className="muted">A/S 접수가 없습니다.</p> : null}
        {(tickets.data?.items ?? []).map((x) => (
          <Link key={x.id} className="card" to={`/service-tickets/${x.id}`}>
            <div className="card-head">
              <strong>A/S #{x.id}</strong>
              <span className="badge">{TICKET_STATUS_LABEL[x.status]}</span>
            </div>
            <div className="muted">
              {formatKstShort(x.createdAt)} · {x.symptom}
            </div>
          </Link>
        ))}
      </section>

      <section aria-labelledby="h-events">
        <h2 id="h-events">지난 일</h2>
        <ul aria-label="지난 일" className="card">
          {[...t.events].reverse().map((e) => (
            <li key={`${e.status}-${e.occurredAt}`}>
              <span className="muted">{formatKstShort(e.occurredAt)}</span> {TERMINAL_EVENT_LABEL[e.status]}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
