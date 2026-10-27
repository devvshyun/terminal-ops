/**
 * 로그인·역할·계정·외부 업체 키(보강 2). 역할 값은 api `auth/role.ts` Role enum과 같아야 한다(contract-assertions.ts가 단언).
 * 역할별로 할 수 있는 일(엔드포인트 표)은 decisions/0052에 있다. 화면은 역할로 메뉴·버튼을 숨기지만 최종 판단은 서버가 한다.
 */
import type { TerminalStatus } from './statuses.js';

/**
 * ADMIN: 계정·역할·외부 업체 키 관리(업무 데이터는 읽기만)
 * OPERATOR: 운영자 — 어드민의 모든 업무 쓰기
 * MONITOR: 운영 관제·개발자 — 읽기 + 관제 작업(이상 찾기, VAN 대조, 주간 리포트 보내기)
 * FIELD: 현장 작업자 — 박스 스캔·검수와 그에 필요한 조회
 * MERCHANT: 가맹점주 — 자기 가맹점 데이터만(`/me/...`)
 */
export type Role = 'ADMIN' | 'OPERATOR' | 'MONITOR' | 'FIELD' | 'MERCHANT';

/** POST /auth/login */
export interface LoginRequest {
  loginId: string;
  password: string;
}

/** GET /auth/me, POST /auth/login 응답 — 지금 로그인한 사람 */
export interface MeView {
  loginId: string;
  displayName: string;
  role: Role;
  /** MERCHANT만 값이 있다 */
  merchantCode: string | null;
}

/** GET /admin/accounts 한 줄 */
export interface AccountView extends MeView {
  id: number;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

/** POST /admin/accounts */
export interface CreateAccountRequest {
  /** 영문 소문자·숫자·`.`·`-`·`_` 3~50자 */
  loginId: string;
  displayName: string;
  /** 10~200자 */
  password: string;
  role: Role;
  /** role이 MERCHANT일 때만, 그때는 꼭 */
  merchantCode?: string | null;
}

/** PATCH /admin/accounts/:id — 준 것만 바꾼다. 역할·가맹점·비밀번호·사용 중지를 바꾸면 그 계정의 세션을 모두 끊는다 */
export interface UpdateAccountRequest {
  displayName?: string;
  role?: Role;
  merchantCode?: string | null;
  password?: string;
  disabled?: boolean;
}

/** 외부 업체 키가 할 수 있는 일(decisions/0054) */
export type PartnerScope = 'terminal-status:read' | 'merchant-terminals:read';

/** GET /admin/partner-keys 한 줄. 키 원문은 없다(만들 때 한 번만 준다) */
export interface PartnerKeyView {
  id: number;
  /** 업체 이름(표시용) */
  name: string;
  /** 키 앞부분(`pk_` + 8자). 어느 키인지 알아보는 용도 */
  prefix: string;
  scopes: PartnerScope[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdBy: string;
  createdAt: string;
}

/** POST /admin/partner-keys 응답 — key(원문)는 이 응답에만 있다 */
export interface CreatedPartnerKeyView extends PartnerKeyView {
  key: string;
}

/** POST /admin/partner-keys */
export interface CreatePartnerKeyRequest {
  name: string;
  scopes: PartnerScope[];
  /** ISO 시각. 없으면 만료 없음 */
  expiresAt?: string | null;
}

/** GET /partner/v1/terminals/:serialNo, GET /partner/v1/merchants/:code/terminals 한 줄 */
export interface PartnerTerminalView {
  serialNo: string;
  modelCode: string;
  status: TerminalStatus;
  merchantCode: string | null;
}
