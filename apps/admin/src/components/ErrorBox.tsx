import { ApiError } from '../api/client';

/** 코드별로 운영자가 할 일을 덧붙인다. 서버 메시지는 그대로 보여 준다 */
const HINT: Record<string, string> = {
  VERSION_CONFLICT: '다른 작업이 먼저 이 단말기를 바꿨습니다. 다시 불러온 뒤 확인하고 시도하세요.',
  INVALID_TRANSITION: '지금 상태에서 할 수 없는 변경입니다.',
  DUPLICATE: '이미 있는 값입니다.',
  PARTNER_ERROR: '외부 업체(가상) 응답이 실패했습니다. 잠시 뒤 다시 시도하세요.',
  VAN_RECONCILIATION_RUNNING: '이미 진행 중인 작업이 있습니다. 끝난 뒤 다시 실행하세요.',
  ANOMALY_SCAN_RUNNING: '이미 진행 중인 작업이 있습니다. 끝난 뒤 다시 실행하세요.',
};

export function describeError(error: unknown): { title: string; detail: string; code: string | null } {
  if (error instanceof ApiError) {
    const hint = (error.code && HINT[error.code]) ?? (error.status === 400 ? '입력값을 확인하세요.' : error.status === 404 ? '찾는 대상이 없습니다.' : null);
    return { title: hint ?? `요청이 실패했습니다(HTTP ${error.status}).`, detail: error.message, code: error.code };
  }
  return { title: '서버에 연결하지 못했습니다. api가 떠 있는지 확인하세요.', detail: error instanceof Error ? error.message : String(error), code: null };
}

/**
 * 공통 오류 표시. 낙관적 락 충돌(409 VERSION_CONFLICT)이면 "다시 불러오기" 버튼을 보여 준다(onReload가 있을 때).
 */
export function ErrorBox({ error, onReload }: { error: unknown; onReload?: () => void }) {
  if (!error) return null;
  const { title, detail, code } = describeError(error);
  return (
    <div className="error" role="alert">
      <strong>{title}</strong>
      <div className="error-detail">
        {detail}
        {code ? <code> {code}</code> : null}
      </div>
      {error instanceof ApiError && error.isVersionConflict && onReload ? (
        <button type="button" onClick={onReload}>
          다시 불러오기
        </button>
      ) : null}
    </div>
  );
}
