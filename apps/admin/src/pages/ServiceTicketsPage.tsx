import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { api } from '../api/client';
import { itemsOf, useBeforeIdList } from '../api/lists';
import { ErrorBox } from '../components/ErrorBox';
import { MoreButton } from '../components/MoreButton';
import { WriteButton } from '../components/WriteButton';
import { formatKst } from '../lib/format';
import { label } from '../lib/labels';

export interface TicketView {
  id: number;
  serialNo: string;
  merchantCode: string;
  symptom: string;
  status: string;
  remoteNote: string | null;
  replacementSerialNo: string | null;
  outboundShipmentId: number | null;
  outboundTrackingNo: string | null;
  openedBy: string;
  createdAt: string;
  closedAt: string | null;
}

export const TICKET_STATUS_LABEL: Record<string, string> = {
  OPEN: '접수됨',
  RESOLVED_REMOTELY: '원격 해결',
  REPLACING: '교체 출고됨',
  CLOSED: '종결',
};

/** A/S 접수 목록과 접수(F7). 접수는 운영 중(IN_SERVICE)인 단말기만 된다 — 서버가 422로 알려 준다 */
export function ServiceTicketsPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [serialNo, setSerialNo] = useState('');
  const [symptom, setSymptom] = useState('');
  const list = useBeforeIdList<TicketView>('service-tickets', '/service-tickets', { status });
  const open = useMutation({
    mutationFn: () => api<TicketView>('/service-tickets', { method: 'POST', body: { serialNo: serialNo.trim(), symptom: symptom.trim() } }),
    onSuccess: async (ticket) => {
      await client.invalidateQueries({ queryKey: ['service-tickets'] });
      await navigate(`/service-tickets/${ticket.id}`);
    },
  });

  return (
    <section>
      <h2>A/S</h2>
      <div className="panel">
        <h3>접수</h3>
        <div className="row">
          <input aria-label="고장 단말기 시리얼" placeholder="시리얼" value={serialNo} onChange={(e) => setSerialNo(e.target.value)} />
          <input aria-label="증상" placeholder="증상" value={symptom} maxLength={200} onChange={(e) => setSymptom(e.target.value)} />
          <WriteButton className="primary" disabled={!serialNo.trim() || !symptom.trim() || open.isPending} onClick={() => open.mutate()}>
            접수
          </WriteButton>
        </div>
        <ErrorBox error={open.error} />
      </div>
      <div className="filters">
        <select aria-label="접수 상태" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">상태 전체</option>
          {Object.entries(TICKET_STATUS_LABEL).map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <ErrorBox error={list.error} />
      <table>
        <thead>
          <tr>
            <th scope="col">번호</th>
            <th scope="col">단말기</th>
            <th scope="col">가맹점</th>
            <th scope="col">증상</th>
            <th scope="col">상태</th>
            <th scope="col">접수</th>
          </tr>
        </thead>
        <tbody>
          {itemsOf(list.data).map((t) => (
            <tr key={t.id}>
              <td>
                <Link to={`/service-tickets/${t.id}`}>#{t.id}</Link>
              </td>
              <td>
                <Link to={`/terminals/${encodeURIComponent(t.serialNo)}`}>{t.serialNo}</Link>
              </td>
              <td>{t.merchantCode}</td>
              <td>{t.symptom}</td>
              <td>{label(TICKET_STATUS_LABEL, t.status)}</td>
              <td>
                {formatKst(t.createdAt)} · {t.openedBy}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <MoreButton hasNextPage={list.hasNextPage} isFetchingNextPage={list.isFetchingNextPage} fetchNextPage={list.fetchNextPage} />
    </section>
  );
}
