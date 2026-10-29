import { SetMetadata } from '@nestjs/common';
import type { PartnerScope } from '@terminal-ops/contracts';
import { Role } from './role.js';

/**
 * 엔드포인트마다 "누가 부를 수 있나"를 하나 단다(decisions/0052). AuthGuard가 읽고, 아무것도 없으면 403(기본 거부).
 * 핸들러(메서드)에만 단다 — 클래스에 달아 여러 메서드에 퍼지게 하지 않는다(표와 코드가 한 줄씩 맞게).
 * 빠뜨리면 test/unit/access-table.spec.ts가 실패한다.
 */
export type Access =
  | { kind: 'public' }
  | { kind: 'roles'; roles: readonly Role[] }
  | { kind: 'device' }
  | { kind: 'partner'; scope: PartnerScope };

export const ACCESS_KEY = 'terminal-ops:access';

/** 로그인 없이(health, 로그인 자체) */
export const Public = () => SetMetadata(ACCESS_KEY, { kind: 'public' } satisfies Access);

/** 로그인한 사람 중 이 역할만 */
export const Roles = (...roles: Role[]) => SetMetadata(ACCESS_KEY, { kind: 'roles', roles } satisfies Access);

/** 단말기(시뮬레이터)가 부르는 API — 단말기 키(decisions/0055) */
export const DeviceAuth = () => SetMetadata(ACCESS_KEY, { kind: 'device' } satisfies Access);

/** 외부 업체 키(Bearer 또는 X-Api-Key)로, 이 scope가 있는 키만(decisions/0054) */
export const PartnerAuth = (scope: PartnerScope) => SetMetadata(ACCESS_KEY, { kind: 'partner', scope } satisfies Access);

/** 사내 직원 전부(가맹점주 빼고). 단말기·검수·발주 조회처럼 현장 작업자도 보는 것 */
export const STAFF = [Role.ADMIN, Role.OPERATOR, Role.MONITOR, Role.FIELD] as const;
/** 사무실 조회(운영 현황·리포트·이력). 현장 작업자는 쓰지 않는다 */
export const OFFICE = [Role.ADMIN, Role.OPERATOR, Role.MONITOR] as const;
/** 운영 관제 보기(보강 6, decisions/0070). 관제 작업(다시 시도·지우기·복구 sweep)은 MONITOR만 */
export const OPS_VIEW = [Role.ADMIN, Role.MONITOR] as const;
/** 로그인한 누구나(내 정보, 로그아웃) */
export const ANY_ROLE = [Role.ADMIN, Role.OPERATOR, Role.MONITOR, Role.FIELD, Role.MERCHANT] as const;
