import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { api } from '../api/client';
import type { Carrier, RemoteCheckRequest, ReplaceRequest, TerminalDetail, TerminalPage, TicketView } from '@terminal-ops/contracts';
import { ErrorBox } from '../components/ErrorBox';
import { WriteButton } from '../components/WriteButton';
import { formatKst } from '../lib/format';
import { CARRIER_LABEL, label } from '../lib/labels';
import { TICKET_STATUS_LABEL } from './ServiceTicketsPage';
import { keys } from '../api/query-keys';

/**
 * A/S 한 건(F7): 원격 점검(해결이면 종결) → 안 되면 교체 출고("새 단말기 출고 + 고장 단말기 회수 요청"을 서버가 한 트랜잭션으로) → 설치 확인.
 * 교체 단말기 후보는 고장 단말기와 같은 모델의 재고(IN_STOCK)다.
 */
export function ServiceTicketDetailPage() {
  const id = Number(useParams().id);
  const validId = Number.isInteger(id) && id > 0;
  const client = useQueryClient();
  const [note, setNote] = useState('');
  const [resolved, setResolved] = useState(false);
  const [replacement, setReplacement] = useState('');
  const [carrier, setCarrier] = useState<Carrier>('BUNGAE');

  const ticket = useQuery({ queryKey: keys.serviceTicket.one(id), queryFn: () => api<TicketView>(`/service-tickets/${id}`), enabled: validId });
  const t = ticket.data;
  const faulty = useQuery({
    queryKey: keys.terminal.detail(t?.serialNo),
    queryFn: () => api<TerminalDetail>(`/terminals/${encodeURIComponent(t!.serialNo)}`),
    enabled: t?.status === 'OPEN',
  });
  const stock = useQuery({
    queryKey: keys.terminals.stock(faulty.data?.modelCode),
    queryFn: () => api<TerminalPage>('/terminals', { query: { status: 'IN_STOCK', modelCode: faulty.data!.modelCode, size: 50 } }),
    enabled: faulty.data !== undefined,
  });

  // 다시 읽은 재고에서 고른 단말기가 사라졌으면 선택을 푼다(파생값)
  const chosen = stock.data?.items.some((s) => s.serialNo === replacement) ? replacement : '';

  const reread = async () => {
    await client.invalidateQueries({ queryKey: keys.serviceTicket.one(id) });
    await client.invalidateQueries({ queryKey: keys.serviceTickets.all });
    await client.invalidateQueries({ queryKey: keys.terminals.all });
    // 교체 출고·설치 확인은 고장·교체 단말기 두 대의 상태를 바꾼다(Day 6 최종 리뷰 Minor 4)
    await client.invalidateQueries({ queryKey: keys.terminal.all });
  };
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api<TicketView>(`/service-tickets/${id}/${path}`, { method: 'POST', body: body ?? {} }),
    onSuccess: async () => {
      setNote('');
      setResolved(false);
      setReplacement('');
      await reread();
    },
    // 실패(422 TICKET_NOT_OPEN 등)는 화면이 낡았다는 뜻일 수 있다: 오류 안내는 두고 서버 상태를 다시 읽는다
    onError: () => void reread(),
  });

  if (!validId) {
    return (
      <section>
        <p>
          <Link to="/service-tickets">← A/S 목록</Link>
        </p>
        <p role="alert">잘못된 주소입니다. A/S 번호는 숫자여야 합니다.</p>
      </section>
    );
  }

  return (
    <section>
      <p>
        <Link to="/service-tickets">← A/S 목록</Link>
      </p>
      <h2>A/S #{id}</h2>
      <ErrorBox error={ticket.error} />
      {t ? (
        <>
          <div className="panel">
            <dl className="info">
              <dt>상태</dt>
              <dd>
                <strong>{label(TICKET_STATUS_LABEL, t.status)}</strong>
              </dd>
              <dt>단말기</dt>
              <dd>
                <Link to={`/terminals/${encodeURIComponent(t.serialNo)}`}>{t.serialNo}</Link> ({t.merchantCode})
              </dd>
              <dt>증상</dt>
              <dd>{t.symptom}</dd>
              <dt>원격 점검</dt>
              <dd>{t.remoteNote ?? '-'}</dd>
              <dt>교체 단말기</dt>
              <dd>{t.replacementSerialNo ? `${t.replacementSerialNo} (운송장 ${t.outboundTrackingNo})` : '-'}</dd>
              <dt>접수</dt>
              <dd>
                {formatKst(t.createdAt)} · {t.openedBy}
              </dd>
              <dt>종결</dt>
              <dd>{formatKst(t.closedAt)}</dd>
            </dl>
          </div>
          <ErrorBox error={act.error} />
          {t.status === 'OPEN' ? (
            <>
              <div className="panel">
                <h3>원격 점검</h3>
                <textarea aria-label="점검 메모" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="row">
                  <label>
                    <input type="checkbox" checked={resolved} onChange={(e) => setResolved(e.target.checked)} /> 원격으로 해결됨(종결)
                  </label>
                  <WriteButton disabled={!note.trim() || act.isPending} onClick={() => act.mutate({ path: 'remote-checks', body: { resolved, note: note.trim() } satisfies RemoteCheckRequest })}>
                    점검 기록
                  </WriteButton>
                </div>
              </div>
              <div className="panel">
                <h3>교체 출고</h3>
                <div className="row">
                  <select aria-label="교체 단말기" value={chosen} onChange={(e) => setReplacement(e.target.value)}>
                    <option value="">같은 모델 재고에서 선택</option>
                    {stock.data?.items.map((s) => (
                      <option key={s.serialNo} value={s.serialNo}>
                        {s.serialNo}
                      </option>
                    ))}
                  </select>
                  <select aria-label="교체 택배사" value={carrier} onChange={(e) => setCarrier(e.target.value as Carrier)}>
                    {Object.entries(CARRIER_LABEL).map(([code, name]) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <WriteButton
                    className="primary"
                    disabled={!chosen || act.isPending}
                    onClick={() => act.mutate({ path: 'replacements', body: { replacementSerialNo: chosen, carrier } satisfies ReplaceRequest })}
                  >
                    교체 출고
                  </WriteButton>
                </div>
                {stock.data && stock.data.items.length === 0 ? <p className="muted">같은 모델의 재고가 없습니다.</p> : null}
                {stock.data && stock.data.total > stock.data.items.length ? (
                  <p className="muted">같은 모델 재고 {stock.data.total}대 중 최근 등록 순 {stock.data.items.length}대만 표시합니다.</p>
                ) : null}
              </div>
            </>
          ) : null}
          {t.status === 'REPLACING' ? (
            <div className="panel">
              <h3>설치 확인</h3>
              <p className="muted">교체 단말기가 가맹점에 설치됐으면 확인합니다(교체 단말기 → 운영 중, 접수 종결).</p>
              <WriteButton className="primary" disabled={act.isPending} onClick={() => act.mutate({ path: 'installations' })}>
                설치 확인
              </WriteButton>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
