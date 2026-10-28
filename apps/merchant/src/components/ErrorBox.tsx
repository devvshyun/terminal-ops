import type { ErrorCode } from '@terminal-ops/contracts';
import { ApiError } from '../api/client';

/**
 * 점주에게 보이는 안내. 어드민 ErrorBox와 모양은 같고 문구가 다르다(운영자 용어·할 일 대신 점주가 할 일, decisions/0060).
 * 서버 메시지(운영자용 문장일 수 있다)는 작은 글씨로 아래에 둔다 — 본사에 문의할 때 그대로 읽어 줄 수 있게.
 */
const HINT: Partial<Record<ErrorCode, string>> = {
  TICKET_ALREADY_OPEN: '이 단말기는 이미 접수된 A/S가 있습니다. A/S 목록에서 진행 상황을 확인하세요.',
  TERMINAL_NOT_IN_SERVICE: '사용 중인 단말기만 고장 접수할 수 있습니다.',
  TICKET_NOT_REPLACING: '지금은 설치 확인을 할 수 없는 단계입니다. 화면을 새로 고쳐 진행 상황을 확인하세요.',
  INVALID_TRANSITION: '교체 단말기가 아직 도착 처리되지 않아 설치 확인을 할 수 없습니다.',
  DEADLOCK: '잠시 뒤 다시 시도하세요.',
  FORBIDDEN: '가맹점 계정으로 로그인해야 쓸 수 있습니다.',
  UNAUTHENTICATED: '로그인이 끝났습니다. 다시 로그인하세요.',
  LOGIN_FAILED: '아이디 또는 비밀번호가 맞지 않습니다.',
  LOGIN_LOCKED: '로그인 실패가 많아 잠시 막혔습니다. 잠시 뒤 다시 시도하세요.',
};

export function describeError(error: unknown): { title: string; detail: string; code: ErrorCode | null } {
  if (error instanceof ApiError) {
    const hint = (error.code && HINT[error.code]) ?? (error.status === 400 ? '입력한 내용을 확인하세요.' : error.status === 404 ? '찾는 내용이 없습니다.' : null);
    return { title: hint ?? `요청이 실패했습니다(HTTP ${error.status}). 잠시 뒤 다시 시도하세요.`, detail: error.message, code: error.code };
  }
  return { title: '서버에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요.', detail: error instanceof Error ? error.message : String(error), code: null };
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
