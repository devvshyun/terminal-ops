import type { BusinessErrorCode, ConflictCode, RuleViolationCode } from '@terminal-ops/contracts';

/**
 * 업무 규칙 위반·충돌. code로 원인을 구분하고 status로 HTTP 상태를 정한다(409 충돌, 422 규칙 위반).
 * 예: SCAN_IN_PROGRESS(409), SCAN_ID_REUSED(422), PO_CLOSED(422)
 * code는 contracts의 유니온만 받는다 — 409에는 ConflictCode, 422에는 RuleViolationCode(decisions/0048). 새 코드는 contracts errors.ts에 먼저 더한다.
 */
export class BusinessError extends Error {
  constructor(status: 409, code: ConflictCode, message: string);
  constructor(status: 422, code: RuleViolationCode, message: string);
  constructor(
    readonly status: 409 | 422,
    readonly code: BusinessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BusinessError';
  }
}

/** 허용되지 않은 상태 전이. HTTP 422로 바뀐다. */
export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransitionError';
  }
}
