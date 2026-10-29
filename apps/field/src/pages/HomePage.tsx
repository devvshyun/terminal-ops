import { Link } from 'react-router';
import { useToday } from '../api/queries';
import { ErrorBox } from '../components/ErrorBox';
import { InspectIcon, ScanIcon } from '../components/icons';

/**
 * 처음 화면: 오늘(KST) 내가 한 일과 큰 버튼 둘(박스 스캔·검수). 숫자는 서버가 센다(GET /field/today, decisions/0063) —
 * 화면이 세면 새로 고치거나 다른 기기에서 한 일이 빠진다.
 */
export function HomePage() {
  const today = useToday();
  const t = today.data;
  return (
    <section>
      <h1>오늘 내 작업</h1>
      <ErrorBox error={today.error} />
      {t ? (
        <>
          <p className="muted date">{t.date} (KST 0시부터)</p>
          <dl className="stats">
            <div>
              <dt>처리한 박스</dt>
              <dd>{t.scans.boxes}개</dd>
            </div>
            <div>
              <dt>입고</dt>
              <dd>{t.scans.received}대</dd>
            </div>
            <div>
              <dt>회수 입고</dt>
              <dd>{t.scans.returned}대</dd>
            </div>
            <div>
              <dt>검수</dt>
              <dd>{t.inspections.total}대</dd>
            </div>
          </dl>
          <p className="muted stats-note">
            검수 합격 {t.inspections.passed} · 불합격 {t.inspections.failed}
            {t.scans.rejected > 0 ? ` · 거절된 줄 ${t.scans.rejected}` : ''}
          </p>
        </>
      ) : today.isPending ? (
        <p className="muted">불러오는 중…</p>
      ) : null}
      <div className="big-actions">
        <Link className="big-button" to="/scan">
          <ScanIcon />
          박스 스캔
        </Link>
        <Link className="big-button alt" to="/inspections">
          <InspectIcon />
          검수
        </Link>
      </div>
    </section>
  );
}
