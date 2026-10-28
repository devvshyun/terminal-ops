import { createHash, timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ApiErrorBody } from '@terminal-ops/contracts';
import { env } from '../config/env.js';
import { ACCESS_KEY, type Access } from './access.js';
import { readCookie, SESSION_COOKIE } from './cookies.js';
import type { Principal, RequestWithPrincipal } from './principal.js';
import { Role } from './role.js';
import { SessionStore } from './session.store.js';

const UNAUTHENTICATED: ApiErrorBody = { statusCode: 401, code: 'UNAUTHENTICATED', message: '로그인이 필요합니다(세션이 없거나 끝났습니다).' };

/** 테스트 전용 헤더(decisions/0056). 기존 테스트의 `X-Operator: kim`이 그대로 로그인 아이디 kim(OPERATOR)이 된다 */
export const TEST_OPERATOR_HEADER = 'x-operator';
export const TEST_ROLE_HEADER = 'x-test-role';
/** 단말기 키 헤더(decisions/0055) */
export const DEVICE_KEY_HEADER = 'x-device-key';

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return '';
  }
}

/** 테스트 전용 헤더의 사람. 이름 규칙은 예전 X-Operator와 같다(1~50자, `system:` 금지). MERCHANT는 가맹점이 없어 받지 않는다(실제 로그인으로) */
export function testPrincipal(operator: string | undefined, role: string | undefined): Principal | null {
  const name = operator ? decodeName(operator) : '';
  if (!name || name.length > 50 || name.startsWith('system:')) return null;
  const r = (role ?? Role.OPERATOR) as Role;
  if (!Object.values(Role).includes(r) || r === Role.MERCHANT) return null;
  return { accountId: null, loginId: name, displayName: name, role: r, merchantId: null, merchantCode: null };
}

/**
 * 모든 HTTP 요청의 문(APP_GUARD, decisions/0052). 핸들러의 Access 메타데이터대로:
 * 없음 → 403(기본 거부), public → 통과, roles → 세션 쿠키의 사람이 그 역할이어야(없으면 401, 역할 밖이면 403),
 * device → `X-Device-Key`가 DEVICE_API_KEY와 같아야(없거나 틀리면 401, decisions/0055).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly deviceKeyDigest = createHash('sha256').update(env.deviceApiKey).digest();

  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionStore,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const access = this.reflector.get<Access | undefined>(ACCESS_KEY, ctx.getHandler());
    const req = ctx.switchToHttp().getRequest<RequestWithPrincipal>();
    if (!access) {
      throw new ForbiddenException({ statusCode: 403, code: 'FORBIDDEN', message: '접근 규칙이 정해지지 않은 API입니다(decisions/0052).' } satisfies ApiErrorBody);
    }
    switch (access.kind) {
      case 'public':
        return true;
      case 'device':
        if (!this.deviceKeyMatches(req.header(DEVICE_KEY_HEADER))) {
          throw new UnauthorizedException({ statusCode: 401, code: 'UNAUTHENTICATED', message: '단말기 키(X-Device-Key)가 없거나 맞지 않습니다.' } satisfies ApiErrorBody);
        }
        return true;
      case 'roles': {
        const principal = await this.principal(req);
        if (!principal) throw new UnauthorizedException(UNAUTHENTICATED);
        if (!access.roles.includes(principal.role)) {
          throw new ForbiddenException({
            statusCode: 403,
            code: 'FORBIDDEN',
            message: `이 작업은 ${access.roles.join(', ')} 역할만 할 수 있습니다(지금: ${principal.role}).`,
          } satisfies ApiErrorBody);
        }
        req.principal = principal;
        return true;
      }
    }
  }

  /** 단말기 키 비교. 길이가 달라도 같은 시간이 들게 양쪽을 SHA-256으로 바꿔 timingSafeEqual(요청마다 해시 하나 — 실험 0017) */
  private deviceKeyMatches(given: string | undefined): boolean {
    if (!given) return false;
    return timingSafeEqual(createHash('sha256').update(given).digest(), this.deviceKeyDigest);
  }

  /** 세션 쿠키가 있으면 그것만 본다(끝난 세션이면 null — 헤더로 넘어가지 않는다). 없을 때만, 테스트에서만 헤더 */
  private async principal(req: RequestWithPrincipal): Promise<Principal | null> {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (token) {
      const session = await this.sessions.get(token);
      // 가맹점이 없는 MERCHANT 세션은 범위를 정할 수 없다 — 로그인 안 한 것으로 본다(Task 1 리뷰, auth.service.ts와 같은 규칙)
      if (session && session.role === Role.MERCHANT && session.merchantId === null) return null;
      return session;
    }
    if (!env.authTestHeaders) return null;
    return testPrincipal(req.header(TEST_OPERATOR_HEADER), req.header(TEST_ROLE_HEADER));
  }
}
