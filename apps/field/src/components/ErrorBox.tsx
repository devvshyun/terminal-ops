import type { ErrorCode } from '@terminal-ops/contracts';
import { ApiError } from '../api/client';

/**
 * 현장 작업자에게 보이는 안내. 점주 앱 ErrorBox와 모양은 같고 문구가 현장 일(박스·검수)에 맞춘 것이다(사본이 아니라 새로 씀 — decisions/0062).
 * 서버 메시지는 작은 글씨로 아래에 둔다(사무실에 물을 때 그대로 읽어 줄 수 있게).
 */
const HINT: Partial<Record<ErrorCode, string>> = {
  SCAN_IN_PROGRESS: '서버가 이 박스를 아직 처리하고 있습니다. 잠시 뒤 같은 박스를 다시 보내세요.',
  SCAN_ID_REUSED: '이 박스 번호로 다른 내용이 이미 처리됐습니다. 새 박스로 다시 시작하세요.',
  PO_CLOSED: '마감된 발주입니다. 다른 발주를 고르세요.',
  PO_NOT_ALLOWED: '회수 입고에는 발주를 고르지 않습니다.',
  VERSION_CONFLICT: '다른 작업과 겹쳤습니다. 처리된 것은 없습니다 — 다시 시도하세요.',
  INVALID_TRANSITION: '지금 상태에서는 할 수 없습니다. 이미 처리됐는지 확인하세요.',
  DEADLOCK: '잠시 뒤 다시 시도하세요.',
  FORBIDDEN: '현장 작업자 계정으로 로그인해야 쓸 수 있습니다.',
  UNAUTHENTICATED: '로그인이 끝났습니다. 다시 로그인하세요.',
  LOGIN_FAILED: '아이디 또는 비밀번호가 맞지 않습니다.',
  LOGIN_LOCKED: '로그인 실패가 많아 잠시 막혔습니다. 잠시 뒤 다시 시도하세요.',
};

export function describeError(error: unknown): { title: string; detail: string; code: ErrorCode | null } {
  if (error instanceof ApiError) {
    const hint = (error.code && HINT[error.code]) ?? (error.status === 400 ? '입력한 내용을 확인하세요.' : error.status === 404 ? '찾는 단말기·자료가 없습니다.' : null);
    return { title: hint ?? `요청이 실패했습니다(HTTP ${error.status}). 잠시 뒤 다시 시도하세요.`, detail: error.message, code: error.code };
  }
  return { title: '서버에 연결하지 못했습니다. 연결을 확인하고 다시 시도하세요.', detail: error instanceof Error ? error.message : String(error), code: null };
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
