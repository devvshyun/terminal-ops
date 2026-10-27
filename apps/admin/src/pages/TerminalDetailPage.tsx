import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { api } from '../api/client';
import type { ConnectivityView, HistoryView, InspectionRecord, TerminalDetail } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { TerminalActions } from '../components/TerminalActions';
import { formatKst } from '../lib/format';
import { label, SOURCE_LABEL, TERMINAL_STATUS_LABEL } from '../lib/labels';

/** 단말기 상세(F1·F2·F8·F13): 기본 정보, 할 수 있는 일, 상태 타임라인, 접속 상태, 검수 기록 */
export function TerminalDetailPage() {
  const serialNo = useParams().serialNo!;
  const client = useQueryClient();
  const base = `/terminals/${encodeURIComponent(serialNo)}`;
  const detail = useQuery({ queryKey: ['terminal', serialNo, 'detail'], queryFn: () => api<TerminalDetail>(base) });
  const history = useQuery({ queryKey: ['terminal', serialNo, 'history'], queryFn: () => api<HistoryView[]>(`${base}/history`) });
  const connectivity = useQuery({ queryKey: ['terminal', serialNo, 'connectivity'], queryFn: () => api<ConnectivityView>(`${base}/connectivity`) });
  const inspections = useQuery({ queryKey: ['terminal', serialNo, 'inspections'], queryFn: () => api<InspectionRecord[]>(`${base}/inspections`) });

  /** 상세·타임라인·접속 상태·검수 기록 모두 다시 읽는다 */
  const reloadAll = () => client.invalidateQueries({ queryKey: ['terminal', serialNo] });

  const t = detail.data;
  return (
    <section>
      <p>
        <Link to="/terminals">← 단말기 목록</Link>
      </p>
      <h2>단말기 {serialNo}</h2>
      <ErrorBox error={detail.error} />
      {detail.isPending ? <p className="muted">불러오는 중</p> : null}
      {t ? (
        <>
          <div className="panel">
            <dl className="info">
              <dt>상태</dt>
              <dd>
                <strong>{label(TERMINAL_STATUS_LABEL, t.status)}</strong> <span className="muted">({t.status}, {formatKst(t.statusChangedAt)}부터)</span>
              </dd>
              <dt>모델</dt>
              <dd>
                {t.modelCode} {t.modelName}
              </dd>
              <dt>가맹점</dt>
              <dd>{t.merchantCode ? `${t.merchantName} (${t.merchantCode})` : '-'}</dd>
              <dt>version</dt>
              <dd>{t.version}</dd>
              <dt>등록</dt>
              <dd>{formatKst(t.createdAt)}</dd>
            </dl>
            <button type="button" onClick={() => void reloadAll()}>
              다시 불러오기
            </button>
          </div>
          <TerminalActions key={t.serialNo} terminal={t} onReload={() => void reloadAll()} />
        </>
      ) : null}

      <div className="panel">
        <h3>접속 상태</h3>
        <ErrorBox error={connectivity.error} />
        {connectivity.data ? (
          connectivity.data.source === 'none' ? (
            <p className="muted">하트비트 기록이 없습니다.</p>
          ) : (
            <p>
              <strong className={connectivity.data.online ? 'ok' : 'bad'}>{connectivity.data.online ? '온라인' : '오프라인'}</strong> 마지막 하트비트{' '}
              {formatKst(connectivity.data.lastSeenAt)}, 펌웨어 {connectivity.data.firmwareVersion ?? '-'}{' '}
              <span className="muted">({connectivity.data.source === 'redis' ? '실시간' : '스냅샷'})</span>
            </p>
          )
        ) : null}
      </div>

      <div className="panel">
        <h3>상태 타임라인</h3>
        <ErrorBox error={history.error} />
        <ol className="timeline" aria-label="상태 타임라인">
          {[...(history.data ?? [])].reverse().map((h, i) => (
            <li key={`${h.occurredAt}-${i}`}>
              <div>
                <strong>
                  {h.fromStatus ? label(TERMINAL_STATUS_LABEL, h.fromStatus) : '신규'} → {label(TERMINAL_STATUS_LABEL, h.toStatus)}
                </strong>{' '}
                <span className="badge">{label(SOURCE_LABEL, h.source)}</span>
              </div>
              <div className="muted">
                {formatKst(h.occurredAt)} · {h.actor} · {h.reason}
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="panel">
        <h3>검수 기록</h3>
        <ErrorBox error={inspections.error} />
        {inspections.data && inspections.data.length === 0 ? <p className="muted">검수 기록이 없습니다.</p> : null}
        {inspections.data?.map((r) => (
          <div key={r.id}>
            <strong className={r.passed ? 'ok' : 'bad'}>{r.passed ? '합격' : '불합격'}</strong> {formatKst(r.inspectedAt)} · {r.actor}
            <ul>
              {r.results.map((x) => (
                <li key={x.itemCode} className={x.passed ? undefined : 'bad'}>
                  {x.label} {x.passed ? '합격' : '불합격'}
                  {x.note ? ` — ${x.note}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
