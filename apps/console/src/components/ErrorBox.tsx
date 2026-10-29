import type { ErrorCode } from '@terminal-ops/contracts';
import { ApiError } from '../api/client';

/**
 * 관제 화면의 오류 안내. 점주·현장 앱 ErrorBox와 모양은 같고 문구가 관제 일(큐·job·sweep)에 맞춘 것이다(사본이 아니라 새로 씀 — decisions/0062·0075).
 * 서버 메시지와 코드는 작은 글씨로 아래에 둔다(개발자가 그대로 찾아볼 수 있게).
 */
const HINT: Partial<Record<ErrorCode, string>> = {
  JOB_NOT_FAILED: '이 job은 이미 실패 상태가 아닙니다(다른 사람이 먼저 다시 시도했거나 지웠을 수 있습니다). 목록을 다시 읽었습니다.',
  FORBIDDEN: '이 작업은 관제 계정만 할 수 있습니다. ADMIN은 보기만 합니다.',
  UNAUTHENTICATED: '로그인이 끝났습니다. 다시 로그인하세요.',
  LOGIN_FAILED: '아이디 또는 비밀번호가 맞지 않습니다.',
  LOGIN_LOCKED: '로그인 실패가 많아 잠시 막혔습니다. 잠시 뒤 다시 시도하세요.',
};

export function describeError(error: unknown): { title: string; detail: string; code: ErrorCode | null } {
  if (error instanceof ApiError) {
    const hint = (error.code && HINT[error.code]) ?? (error.status === 404 ? '찾는 큐·job이 없습니다(이미 지워졌을 수 있습니다).' : error.status === 400 ? '요청 값을 확인하세요.' : null);
    return { title: hint ?? `요청이 실패했습니다(HTTP ${error.status}).`, detail: error.message, code: error.code };
  }
  return { title: 'api 서버에 연결하지 못했습니다. api가 떠 있는지 확인하세요.', detail: error instanceof Error ? error.message : String(error), code: null };
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const { title, detail, code } = describeError(error);
  return (
    <div className="error" role="alert">
      <strong>{title}</strong>
      <small className="error-detail">
        {detail}
        {code ? ` (${code})` : null}
      </small>
    </div>
  );
}
