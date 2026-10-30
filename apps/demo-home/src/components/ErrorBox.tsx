import type { ErrorCode } from '@terminal-ops/contracts';
import { ApiError } from '../api/client';
import { SERVER_INFO, ServerDown, ServerError } from '../lib/servers';

/**
 * 시연 홈의 오류 안내. 개발자센터 ErrorBox와 모양이 같고(사본이 아니라 새로 씀 — decisions/0062·0075), 시연 중 자주 만나는 경우를 풀어 쓴다.
 * 가상 업체·시뮬레이터가 안 떠 있으면 띄우는 명령을(시연 도구 ErrorBox와 같다).
 */
const HINT: Partial<Record<ErrorCode, string>> = {
  ROLLOUT_ALREADY_ACTIVE: '같은 모델에 진행 중인 배포가 있습니다. 진행 중인 배포가 끝나면(또는 어드민 "펌웨어 배포"에서 중단하면) 다시 실행하세요.',
  VERSION_CONFLICT: '그 사이 다른 화면에서 같은 단말기를 바꿨습니다. 다시 실행하세요.',
  FORBIDDEN: '이 실행은 운영자(operator)만 할 수 있습니다.',
  UNAUTHENTICATED: '로그인이 끝났습니다. 위에서 다시 로그인하세요.',
  LOGIN_FAILED: '아이디 또는 비밀번호가 맞지 않습니다.',
  LOGIN_LOCKED: '로그인 실패가 많아 잠시 막혔습니다. 잠시 뒤 다시 시도하세요.',
};

export function describeError(error: unknown): { title: string; detail: string; code: ErrorCode | null } {
  if (error instanceof ApiError) {
    const hint = (error.code && HINT[error.code]) ?? null;
    return { title: hint ?? `요청이 실패했습니다(HTTP ${error.status}).`, detail: error.message, code: error.code };
  }
  if (error instanceof ServerDown) return { title: error.message, detail: `띄우기: ${SERVER_INFO[error.server].start}`, code: null };
  if (error instanceof ServerError) return { title: `${SERVER_INFO[error.server].label}가 거절했습니다(HTTP ${error.status}).`, detail: error.message, code: null };
  return { title: 'api 서버에 연결하지 못했습니다. 시연 묶음이 떠 있는지 확인하세요.', detail: error instanceof Error ? error.message : String(error), code: null };
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
