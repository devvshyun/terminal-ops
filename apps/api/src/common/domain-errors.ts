/**
 * 업무 규칙 위반·충돌. code로 원인을 구분하고 status로 HTTP 상태를 정한다(409 충돌, 422 규칙 위반).
 * 예: SCAN_IN_PROGRESS(409), SCAN_ID_REUSED(422), PO_CLOSED(422)
 */
export class BusinessError extends Error {
  constructor(
    readonly status: 409 | 422,
    readonly code: string,
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
