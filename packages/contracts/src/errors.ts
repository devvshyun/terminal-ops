/**
 * 오류 응답의 원인 코드(`code`). 화면은 code로 원인을 가른다(어드민 ErrorBox 안내, 다시 보내도 되는지 등).
 * BusinessError는 타입으로(생성자가 이 유니온의 코드만 받는다), 나머지 오류 본문은 `satisfies ApiErrorBody` 관례로 지킨다(decisions/0048).
 */

/** 업무 규칙 충돌(409) — api BusinessError(409, …) */
export type ConflictCode =
  | 'ANOMALY_SCAN_RUNNING'
  | 'JOB_NOT_FAILED'
  | 'LAST_ADMIN'
  | 'REPLACEMENT_RESERVED'
  | 'ROLLOUT_ALREADY_ACTIVE'
  | 'SCAN_IN_PROGRESS'
  | 'TICKET_ALREADY_OPEN'
  | 'VAN_RECONCILIATION_RUNNING'
  | 'WEEKLY_REPORT_IN_PROGRESS';

/** 업무 규칙 위반(422) — api BusinessError(422, …) */
export type RuleViolationCode =
  | 'MODEL_MISMATCH'
  | 'PO_ALREADY_CLOSED'
  | 'PO_CLOSED'
  | 'REPLACEMENT_NOT_IN_STOCK'
  | 'ROLLOUT_FINISHED'
  | 'ROLLOUT_NOT_PAUSED'
  | 'ROLLOUT_NOT_RUNNING'
  | 'SCAN_ID_REUSED'
  | 'TERMINAL_NOT_IN_SERVICE'
  | 'TICKET_NOT_OPEN'
  | 'TICKET_NOT_REPLACING'
  | 'WEEK_NOT_ENDED'
  | 'WEEKLY_REPORT_TOO_LARGE';

/** api BusinessError가 쓰는 코드 */
export type BusinessErrorCode = ConflictCode | RuleViolationCode;

/** 오류 필터(DomainExceptionFilter)가 ORM·도메인·외부 업체 오류에서 만드는 코드 */
export type FilterErrorCode = 'VERSION_CONFLICT' | 'DEADLOCK' | 'DUPLICATE' | 'INVALID_TRANSITION' | 'PARTNER_ERROR';

/** 입력 오류(400)·파일 크기(413) 중 code를 붙여 주는 것. ValidationPipe의 항목별 검증 오류에는 code가 없다 */
export type InputErrorCode =
  | 'INVALID_STAGES'
  | 'INVALID_WEEK_START'
  | 'PO_NOT_ALLOWED'
  | 'INVALID_FILE'
  | 'FILE_TOO_LARGE'
  | 'MISSING_COLUMNS'
  | 'TOO_MANY_ROWS';

/**
 * 인증·권한(보강 2). 401 UNAUTHENTICATED: 로그인(세션)·키가 없거나 끝남 → 화면은 로그인으로. 403 FORBIDDEN: 로그인했지만 역할·범위 밖.
 * 401 LOGIN_FAILED: 아이디·비밀번호가 틀림(어느 쪽인지 말하지 않는다). 429 LOGIN_LOCKED: 실패가 많아 잠시 막음.
 * 400 MERCHANT_REQUIRED: MERCHANT 계정에 가맹점이 없거나, 다른 역할에 가맹점을 줌
 * (409 LAST_ADMIN — 마지막 활성 ADMIN을 사용 중지·강등하려 함 — 은 ConflictCode)
 */
export type AuthErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'LOGIN_FAILED' | 'LOGIN_LOCKED' | 'MERCHANT_REQUIRED';

export type ErrorCode = BusinessErrorCode | FilterErrorCode | InputErrorCode | AuthErrorCode;

/** 오류 응답 본문. 404·ValidationPipe 400에는 code가 없고, ValidationPipe의 message는 항목별 배열이다 */
export interface ApiErrorBody {
  statusCode: number;
  code?: ErrorCode;
  message: string | string[];
}

/** 검수 결과가 모델 체크리스트와 맞지 않을 때의 400 본문(POST /terminals/:serialNo/inspections). code가 없고 어긋난 항목 코드를 나열한다 */
export interface InspectionMismatchBody {
  statusCode: 400;
  message: string;
  missing: string[];
  unknown: string[];
  duplicated: string[];
}

/** 502 PARTNER_ERROR: 외부 업체 쪽 실패. reason = 원인 분류(PartnerError의 name) */
export interface PartnerErrorBody extends ApiErrorBody {
  code: 'PARTNER_ERROR';
  reason: string;
}
