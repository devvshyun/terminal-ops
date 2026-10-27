import { createParamDecorator, type ExecutionContext, InternalServerErrorException } from '@nestjs/common';
import type { MeView } from '@terminal-ops/contracts';
import type { Request } from 'express';
import type { Role } from './role.js';

/** 요청한 사람(로그인 세션, 또는 테스트 전용 헤더). AuthGuard가 `req.principal`에 넣는다 */
export interface Principal {
  /** 계정 id. 테스트 전용 헤더로 들어온 사람은 null(계정 행이 없다) */
  accountId: number | null;
  loginId: string;
  displayName: string;
  role: Role;
  /** MERCHANT만 값이 있다 — 범위 조건에 쓴다(decisions/0053) */
  merchantId: number | null;
  merchantCode: string | null;
}

export type RequestWithPrincipal = Request & { principal?: Principal };

/** 핸들러에서 지금 사람을 받는다. `@Roles()`가 없는 핸들러(가드가 사람을 확인하지 않은 곳)에서 쓰면 500 — 코드 실수다 */
export const CurrentPrincipal = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal => {
  const principal = ctx.switchToHttp().getRequest<RequestWithPrincipal>().principal;
  if (!principal) throw new InternalServerErrorException('로그인한 사람이 없습니다 — 이 핸들러에 @Roles()가 있어야 합니다.');
  return principal;
});

export function toMeView(p: Principal): MeView {
  return { loginId: p.loginId, displayName: p.displayName, role: p.role, merchantCode: p.merchantCode };
}
