import { Link } from 'react-router';
import { useInspectionQueue } from '../api/queries';
import { ErrorBox } from '../components/ErrorBox';
import { SerialFinder } from '../components/SerialFinder';
import { formatKstShort } from '../lib/format';
import { QUEUE_KIND_LABEL } from '../lib/labels';

/**
 * 검수 대기(보강 4). 위: 시리얼을 스캔(키보드 웨지 + Enter)하면 그 단말기 검수 화면으로 바로 간다 — 손에 든 단말기부터 검수한다.
 * 아래: 기다리는 단말기(새 입고·회수 입고, 오래 기다린 것부터). 목록에 없어도 스캔으로 찾을 수 있다(검수할 수 있는지는 서버가 정한다).
 */
export function InspectionQueuePage() {
  const queue = useInspectionQueue();
  const shown = queue.data?.items.length ?? 0;
  return (
    <section>
      <h1>검수</h1>
      <SerialFinder />

      <h2>검수 대기 {queue.data ? `${queue.data.total}대` : ''}</h2>
      <ErrorBox error={queue.error} />
      {queue.data && queue.data.total > shown ? <p className="muted">{queue.data.total}대 중 오래 기다린 순으로 {shown}대만 보입니다(상태별 최근 100대).</p> : null}
      {queue.data && shown === 0 ? <p className="muted">검수할 단말기가 없습니다.</p> : null}
      <ul className="queue">
        {queue.data?.items.map((t) => (
          <li key={t.serialNo}>
            <Link className="queue-item" to={`/inspections/${encodeURIComponent(t.serialNo)}`}>
              <span className="serial">{t.serialNo}</span>
              <span className="badge">{QUEUE_KIND_LABEL[t.status as keyof typeof QUEUE_KIND_LABEL] ?? t.status}</span>
              <small className="muted">
                {t.modelCode} · {formatKstShort(t.statusChangedAt)}부터
              </small>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
