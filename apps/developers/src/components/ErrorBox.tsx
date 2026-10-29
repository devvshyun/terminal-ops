import type { ErrorCode } from '@terminal-ops/contracts';
import { ApiError } from '../api/client';

/**
 * 개발자센터의 오류 안내. 관제 앱 ErrorBox와 모양은 같고 문구가 업체·키 일에 맞춘 것이다(사본이 아니라 새로 씀 — decisions/0062·0075).
 * 서버 메시지와 코드는 작은 글씨로 아래에 둔다(개발자가 그대로 찾아볼 수 있게).
 */
const HINT: Partial<Record<ErrorCode, string>> = {
  DUPLICATE: '같은 코드의 업체가 이미 있습니다.',
  FORBIDDEN: '이 작업은 ADMIN 계정만 할 수 있습니다.',
  UNAUTHENTICATED: '로그인이 끝났습니다. 다시 로그인하세요.',
  LOGIN_FAILED: '아이디 또는 비밀번호가 맞지 않습니다.',
  LOGIN_LOCKED: '로그인 실패가 많아 잠시 막혔습니다. 잠시 뒤 다시 시도하세요.',
};

/** 코드 없는 응답의 상태별 안내 */
const STATUS_HINT: Partial<Record<number, string>> = {
  404: '찾는 업체·키가 없습니다.',
  400: '입력 값을 확인하세요.',
};

export function describeError(error: unknown): { title: string; detail: string; code: ErrorCode | null } {
  if (error instanceof ApiError) {
    const hint = (error.code && HINT[error.code]) ?? STATUS_HINT[error.status] ?? null;
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
