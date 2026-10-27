import { createParamDecorator, type ExecutionContext, InternalServerErrorException } from '@nestjs/common';
import type { RequestWithPrincipal } from '../auth/principal.js';

/**
 * 요청한 작업자 — 로그인한 계정의 로그인 아이디(decisions/0056). 이력·검수·스캔·배포의 actor로 남는다.
 * 전에는 `X-Operator` 헤더를 그대로 믿었다(decisions/0001, 대체됨). 이제 헤더는 테스트 전용 인증 길에서만 읽는다(auth.guard.ts).
 * AuthGuard가 `@Roles()` 핸들러에서 사람을 확인한 뒤라 여기서는 꺼내기만 한다. 시스템 작업의 `system:<작업명>`은 그대로다.
 */
export const Operator = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const principal = ctx.switchToHttp().getRequest<RequestWithPrincipal>().principal;
  if (!principal) throw new InternalServerErrorException('로그인한 사람이 없습니다 — 이 핸들러에 @Roles()가 있어야 합니다.');
  return principal.loginId;
});
