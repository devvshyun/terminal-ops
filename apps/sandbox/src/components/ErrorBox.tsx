import { SERVER_INFO, ServerDown, ServerError } from '../lib/servers';

/** 오류 안내: 서버가 안 떠 있으면 띄우는 명령, 서버가 거절했으면 그 이유 */
export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  if (error instanceof ServerDown) {
    return (
      <div className="error" role="alert">
        <strong>{error.message}</strong>
        <small className="error-detail">
          띄우기: <code>{SERVER_INFO[error.server].start}</code>
        </small>
      </div>
    );
  }
  return (
    <div className="error" role="alert">
      <strong>{error instanceof ServerError ? `${SERVER_INFO[error.server].label}가 거절했습니다(HTTP ${error.status}).` : '요청이 실패했습니다.'}</strong>
      <small className="error-detail">{error instanceof Error ? error.message : String(error)}</small>
    </div>
  );
}
