import { Link, useParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MerchantTicketView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { useMyTicket } from '../api/queries';
import { keys } from '../api/query-keys';
import { ErrorBox } from '../components/ErrorBox';
import { StepList } from '../components/StepList';
import { formatKst } from '../lib/format';
import { TERMINAL_STATUS_LABEL, TICKET_STATUS_LABEL } from '../lib/labels';
import { canConfirmInstall, ticketSteps } from '../lib/steps';

/**
 * A/S 한 건: 진행 단계(접수 → 원격 점검 → 교체 출고 → 배송 중 → 설치 확인 → 완료), 교체 단말기, 설치 확인 버튼.
 * 설치 확인은 되돌릴 수 없어 한 번 더 묻는다(어드민과 같은 규칙, decisions/0041). 성공·실패 모두 'me' 묶음을 다시 읽는다 —
 * 실패(422)는 대개 화면이 낡았다는 뜻이다(본사가 먼저 바꿨거나 아직 배송 완료 전).
 * 교체 단말기 상태(replacementStatus)는 교체 중(REPLACING)일 때만 오고 그 밖에는 null이다 — null이어도 그려진다.
 */
export function ServiceTicketDetailPage() {
  const id = Number(useParams().id);
  const client = useQueryClient();
  const ticket = useMyTicket(id);
  const install = useMutation({
    mutationFn: () => api<MerchantTicketView>(`/me/service-tickets/${id}/installations`, { method: 'POST' }),
    onSettled: () => client.invalidateQueries({ queryKey: keys.all }),
  });

  if (ticket.error) return <ErrorBox error={ticket.error} />;
  if (!ticket.data) return <p>불러오는 중…</p>;
  const t = ticket.data;

  const confirm = () => {
    if (window.confirm('교체 단말기를 설치하고 결제가 되는 것을 확인했나요? 확인하면 A/S가 완료됩니다.')) install.mutate();
  };

  return (
    <>
      <h1>A/S #{t.id}</h1>
      <p>
        <span className="badge">{TICKET_STATUS_LABEL[t.status]}</span>
      </p>
      <dl className="facts">
        <dt>단말기</dt>
        <dd>
          <Link to={`/terminals/${encodeURIComponent(t.serialNo)}`}>{t.serialNo}</Link>
        </dd>
        <dt>증상</dt>
        <dd>{t.symptom}</dd>
        <dt>접수</dt>
        <dd>
          {formatKst(t.createdAt)}
          {t.openedByMe ? '' : ' (본사 또는 다른 계정이 접수)'}
        </dd>
        {t.closedAt ? (
          <>
            <dt>끝난 때</dt>
            <dd>{formatKst(t.closedAt)}</dd>
          </>
        ) : null}
      </dl>

      <h2>진행 단계</h2>
      <StepList label="A/S 진행 단계" steps={ticketSteps(t)} />

      {t.replacementSerialNo ? (
        <section aria-labelledby="h-replacement">
          <h2 id="h-replacement">교체 단말기</h2>
          <p>
            <Link to={`/terminals/${encodeURIComponent(t.replacementSerialNo)}`}>{t.replacementSerialNo}</Link>
            {t.replacementStatus ? ` · ${TERMINAL_STATUS_LABEL[t.replacementStatus]}` : null}
            {t.outboundTrackingNo ? <span className="muted"> · 운송장 {t.outboundTrackingNo}</span> : null}
          </p>
        </section>
      ) : null}

      {t.status === 'REPLACING' && t.replacementStatus === 'SHIPPED' ? <p className="notice">교체 단말기가 배송 중입니다. 도착하면 설치 확인을 할 수 있습니다.</p> : null}
      {canConfirmInstall(t) ? (
        <>
          <p className="notice">교체 단말기가 도착했습니다. 설치하고 카드 결제가 되는지 확인한 뒤 눌러 주세요.</p>
          <button type="button" className="primary" disabled={install.isPending} onClick={confirm}>
            설치 확인
          </button>
        </>
      ) : null}
      {t.status === 'RESOLVED_REMOTELY' ? <p className="notice">본사가 원격으로 해결했습니다. 다시 문제가 생기면 새로 접수해 주세요.</p> : null}
      <ErrorBox error={install.error} />
    </>
  );
}
