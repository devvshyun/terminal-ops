import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { MerchantTerminalView, TerminalStatus } from '@terminal-ops/contracts';
import { useMyTerminals, useMyTickets } from '../api/queries';
import { ErrorBox } from '../components/ErrorBox';
import { currentStep } from '../components/StepList';
import { ConnectivityLine, ShipmentLine, StatusBadge } from '../components/TerminalBits';
import { RETURN_GUIDE, TICKET_STATUS_LABEL } from '../lib/labels';
import { ticketSteps } from '../lib/steps';

const COMING: TerminalStatus[] = ['ALLOCATED', 'SHIPPED', 'DELIVERED'];
const RETURNS: TerminalStatus[] = ['RETURN_REQUESTED', 'RETURNING', 'RETURNED'];

function TerminalCard({ t, now, children }: { t: MerchantTerminalView; now: Date; children?: ReactNode }) {
  return (
    <Link className="card" to={`/terminals/${encodeURIComponent(t.serialNo)}`}>
      <div className="card-head">
        <strong>{t.modelName}</strong>
        <StatusBadge status={t.status} />
      </div>
      <div className="muted">{t.serialNo}</div>
      {t.connectivity ? (
        <div>
          <ConnectivityLine c={t.connectivity} now={now} />
          {t.connectivity.firmwareVersion ? <span className="muted"> · 펌웨어 {t.connectivity.firmwareVersion}</span> : null}
        </div>
      ) : null}
      {children}
    </Link>
  );
}

/**
 * 홈(점주가 가장 먼저 보는 화면, decisions/0060): 오고 있는 단말기(배송) → 진행 중 A/S → 사용 중 단말기(접속) → 회수 순서.
 * 점주가 지금 기다리거나 해야 할 일이 위에 온다. 단말기를 누르면 상세(이력·배송 단계·고장 접수).
 */
export function HomePage() {
  const terminals = useMyTerminals();
  const tickets = useMyTickets();
  const now = new Date(terminals.dataUpdatedAt || Date.now());

  if (terminals.error) return <ErrorBox error={terminals.error} />;
  if (!terminals.data) return <p>불러오는 중…</p>;

  const items = terminals.data.items;
  const coming = items.filter((t) => COMING.includes(t.status));
  const inService = items.filter((t) => t.status === 'IN_SERVICE');
  const returns = items.filter((t) => RETURNS.includes(t.status));
  const openTickets = (tickets.data?.items ?? []).filter((t) => t.status === 'OPEN' || t.status === 'REPLACING');

  return (
    <>
      {items.length === 0 ? <p className="muted">우리 매장에 등록된 단말기가 없습니다.</p> : null}
      {terminals.data.total > items.length ? (
        <p className="muted">
          {terminals.data.total}대 중 최근 {items.length}대만 보입니다.
        </p>
      ) : null}

      {coming.length > 0 ? (
        <section aria-labelledby="h-coming">
          <h2 id="h-coming">오고 있는 단말기</h2>
          {coming.map((t) => (
            <TerminalCard key={t.serialNo} t={t} now={now}>
              {t.shipment ? (
                <div>
                  <ShipmentLine s={t.shipment} />
                  {t.shipment.ticketId ? <div className="muted">A/S #{t.shipment.ticketId} 교체 단말기</div> : null}
                </div>
              ) : null}
              {t.status === 'DELIVERED' ? (
                <div className="muted">{t.shipment?.ticketId ? '설치한 뒤 A/S 화면에서 설치 확인을 눌러 주세요.' : '설치가 끝나면 사용 중으로 바뀝니다.'}</div>
              ) : null}
            </TerminalCard>
          ))}
        </section>
      ) : null}

      <section aria-labelledby="h-tickets">
        <h2 id="h-tickets">진행 중인 A/S</h2>
        {tickets.error ? <ErrorBox error={tickets.error} /> : null}
        {tickets.data && openTickets.length === 0 ? <p className="muted">진행 중인 A/S가 없습니다.</p> : null}
        {openTickets.map((t) => (
          <Link key={t.id} className="card" to={`/service-tickets/${t.id}`}>
            <div className="card-head">
              <strong>A/S #{t.id}</strong>
              <span className="badge warn">{TICKET_STATUS_LABEL[t.status]}</span>
            </div>
            <div className="muted">
              {t.serialNo} · {t.symptom}
            </div>
            <div>지금 단계: {currentStep(ticketSteps(t))}</div>
          </Link>
        ))}
      </section>

      {inService.length > 0 ? (
        <section aria-labelledby="h-terminals">
          <h2 id="h-terminals">사용 중인 단말기</h2>
          {inService.map((t) => (
            <TerminalCard key={t.serialNo} t={t} now={now} />
          ))}
        </section>
      ) : null}

      {returns.length > 0 ? (
        <section aria-labelledby="h-returns">
          <h2 id="h-returns">회수</h2>
          {returns.map((t) => (
            <TerminalCard key={t.serialNo} t={t} now={now}>
              <div className="muted">{RETURN_GUIDE[t.status]}</div>
            </TerminalCard>
          ))}
        </section>
      ) : null}
    </>
  );
}
