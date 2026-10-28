import type { RowResultCode } from '@terminal-ops/contracts';
import { ApiError } from '../api/client';

/**
 * 박스 스캔 규칙(보강 4, decisions/0064). 멱등 규칙은 어드민 `apps/admin/src/pages/ScanPage.tsx`와 같다(decisions/0020과 그 리뷰 반영, 어드민 decisions/0041 Task 6):
 * scanId는 처음 보낼 때 만들고 결과를 받거나 박스를 버릴 때까지 지킨다. 다시 보낼지 고칠지는 오류 종류로 가른다(`retryable`).
 */

/** 시리얼 형식 — api `terminal/bulk-rows.ts` SERIAL_NO_PATTERN과 같은 식. 화면은 미리 알려 주기만 하고 판정은 서버 행 결과(INVALID_FORMAT)다 */
export const SERIAL_PATTERN = /^[A-Z0-9-]{4,32}$/;

/** 한 박스 최대 행 수(api CreateScanDto `@ArrayMaxSize(500)`) */
export const MAX_BOX = 500;

/** 박스마다 만드는 멱등 키(서버 규칙: 영문·숫자·_·- 8~64자) */
export function newScanId(): string {
  return `BOX-${crypto.randomUUID()}`;
}

/** 한 번에 들어온 글(스캐너 한 줄 또는 붙여 넣기)을 시리얼로: 줄·쉼표·공백으로 나누고 빈 것은 뺀다(순서 유지 — 서버가 행별 결과를 같은 순서로 준다) */
export function splitSerials(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 목록 한 줄의 문제. 앞에 같은 시리얼이 있으면 중복(서버도 뒤의 것을 DUPLICATE_IN_REQUEST로 거절한다), 형식이 틀리면 형식 */
export type LineProblem = 'DUPLICATE' | 'FORMAT' | null;

export function lineProblem(serials: readonly string[], index: number): LineProblem {
  const serial = serials[index];
  if (serials.indexOf(serial) < index) return 'DUPLICATE';
  if (!SERIAL_PATTERN.test(serial)) return 'FORMAT';
  return null;
}

/**
 * 이 오류면 같은 박스를 같은 scanId로 다시 보내면 된다: 처리 중(409 SCAN_IN_PROGRESS)·연결 실패·5xx, 그리고 회수 박스가 다른 작업과 겹쳐
 * 통째로 되돌려진 409 VERSION_CONFLICT(서버가 결과를 저장하지 않았으니 같은 내용을 다시 보내면 처음부터 처리한다). 그 밖(입력 오류 등)은 박스를 고쳐 새 scanId로.
 */
export function retryable(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500 || (error.status === 409 && (error.code === 'SCAN_IN_PROGRESS' || error.code === 'VERSION_CONFLICT'));
}

/** 행 결과의 현장 문구(서버 코드는 옆에 작게 — 사무실에 물을 때) */
export const RESULT_LABEL: Record<RowResultCode, string> = {
  CREATED: '입고됨',
  RETURNED: '회수 입고됨',
  INVALID_FORMAT: '형식 오류',
  DUPLICATE_IN_REQUEST: '박스 안 중복',
  UNKNOWN_MODEL: '모르는 모델',
  ALREADY_EXISTS: '이미 등록됨',
  NOT_IN_DELIVERY_NOTE: '납품 명세에 없음',
  NOT_FOUND: '없는 단말기',
  INVALID_STATE: '지금 상태로는 안 됨',
};

export const SUCCESS: ReadonlySet<RowResultCode> = new Set<RowResultCode>(['CREATED', 'RETURNED']);
