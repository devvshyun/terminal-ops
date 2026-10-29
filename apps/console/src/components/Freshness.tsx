import { formatKst } from '../lib/format';
import { ErrorBox } from './ErrorBox';

/**
 * 읽기 쿼리 하나의 "마지막 갱신" 줄(decisions/0076). 다시 읽다 실패하면 TanStack Query는 마지막 값을 그대로 두므로,
 * 화면에는 그 값을 두고 위에 오류와 "N 시각 값"을 함께 보인다 — 숫자가 멈춘 것을 모르고 보지 않게.
 */
export function Freshness({ updatedAt, fetching, error }: { updatedAt: number; fetching: boolean; error: unknown }) {
  return (
    <>
      <p className="muted" role="status">
        {updatedAt ? `마지막 갱신 ${formatKst(new Date(updatedAt).toISOString())}` : '읽는 중…'}
        {fetching && updatedAt ? ' · 다시 읽는 중' : ''}
      </p>
      {error ? <ErrorBox error={error} /> : null}
    </>
  );
}
