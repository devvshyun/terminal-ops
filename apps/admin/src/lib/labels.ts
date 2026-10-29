import type { Carrier, Role, RowResultCode, TerminalStatus, TransitionSource } from '@terminal-ops/contracts';

/**
 * 화면에 보이는 이름만 둔다(규칙은 두지 않는다 — 가능한 전이는 서버가 준다, decisions/0040).
 * 키는 contracts의 상태 유니온이다 — 값이 하나라도 빠지거나 없는 값이 있으면 tsc가 막는다(decisions/0048). 모르는 값이 오면 값을 그대로 보여 준다(label()).
 */
/** 역할(api decisions/0052) */
export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: '관리자',
  OPERATOR: '운영자',
  MONITOR: '관제',
  FIELD: '현장 작업자',
  MERCHANT: '가맹점주',
};

export const TERMINAL_STATUS_LABEL: Record<TerminalStatus, string> = {
  RECEIVED: '입고',
  INSPECTED: '검수 합격',
  DEFECTIVE: '불량',
  IN_STOCK: '재고',
  ALLOCATED: '배정',
  SHIPPED: '출고(배송 중)',
  DELIVERED: '배송 완료',
  IN_SERVICE: '운영 중',
  RETURN_REQUESTED: '회수 요청',
  RETURNING: '회수 중',
  RETURNED: '회수 입고',
  DISPOSED: '폐기',
};

export const TERMINAL_STATUSES = Object.keys(TERMINAL_STATUS_LABEL) as TerminalStatus[];

export const SOURCE_LABEL: Record<TransitionSource, string> = {
  MANUAL: '수동',
  INSPECTION: '검수',
  BATCH: '배치',
  ALLOCATION: '배정',
  SHIPMENT: '출고',
  SCAN: '박스 스캔',
  IMPORT: '엑셀 등록',
  SERVICE: 'A/S',
};

/** 일괄 등록(엑셀)의 행 결과(보강 5). 박스 스캔 화면은 코드를 그대로 보인다 */
export const ROW_RESULT_LABEL: Record<RowResultCode, string> = {
  CREATED: '등록됨',
  RETURNED: '회수 입고됨',
  INVALID_FORMAT: '형식 오류',
  DUPLICATE_IN_REQUEST: '파일 안 중복',
  UNKNOWN_MODEL: '모르는 모델',
  ALREADY_EXISTS: '이미 등록됨',
  NOT_IN_DELIVERY_NOTE: '납품 명세에 없음',
  NOT_FOUND: '없는 단말기',
  INVALID_STATE: '지금 상태로는 안 됨',
};

export const CARRIER_LABEL: Record<Carrier, string> = {
  BUNGAE: '번개택배',
  NEURIMBO: '느림보물류',
};

/** 표에 쓸 이름. 모르는 값은 그대로 */
export function label(map: Record<string, string>, value: string | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return map[value] ?? value;
}

/**
 * 상태를 생애주기 구간으로 묶는다(decisions/0079). 상태 이름표 색과 처음 화면의 생애주기 막대가 쓴다 — 현장·매장 앱과 같은 구간(decisions/0077).
 * 키가 TerminalStatus라 상태가 늘면 tsc가 빠진 구간을 알려 준다.
 */
export type LifeStage = 'intake' | 'stock' | 'move' | 'live' | 'back' | 'bad';

export const STATUS_STAGE: Record<TerminalStatus, LifeStage> = {
  RECEIVED: 'intake',
  INSPECTED: 'intake',
  DEFECTIVE: 'bad',
  IN_STOCK: 'stock',
  ALLOCATED: 'move',
  SHIPPED: 'move',
  DELIVERED: 'move',
  IN_SERVICE: 'live',
  RETURN_REQUESTED: 'back',
  RETURNING: 'back',
  RETURNED: 'back',
  DISPOSED: 'bad',
};

export const STAGE_LABEL: Record<LifeStage, string> = {
  intake: '입고·검수',
  stock: '재고',
  move: '배정·배송',
  live: '운영 중',
  back: '회수',
  bad: '불량·폐기',
};

export const STAGES: LifeStage[] = ['intake', 'stock', 'move', 'live', 'back', 'bad'];
