import {
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  HttpCode,
  Injectable,
  Post,
  Req,
  Res,
  UnsupportedMediaTypeException,
  UseGuards,
} from '@nestjs/common';
import type { ApiErrorBody, MeView } from '@terminal-ops/contracts';
import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { ANY_ROLE, Public, Roles } from './access.js';
import { AuthService } from './auth.service.js';
import { readCookie, SESSION_COOKIE } from './cookies.js';
import { LoginDto } from './dto/login.dto.js';
import { CurrentPrincipal, toMeView, type Principal } from './principal.js';

/**
 * JSON 본문만 받는다(Task 2 리뷰). HTML 폼은 application/json을 보낼 수 없어, 다른 사이트의 폼이 이 브라우저를 공격자 계정으로 로그인시키지 못한다(로그인 CSRF).
 * 본문 검증(ValidationPipe)보다 먼저 보려고 가드로 둔다 — 파이프 뒤에 보면 text/plain은 빈 본문이라 400이 먼저 난다.
 */
@Injectable()
class JsonBodyOnly implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.switchToHttp().getRequest<Request>().is('application/json')) return true;
    throw new UnsupportedMediaTypeException({ statusCode: 415, message: '로그인은 JSON 본문(Content-Type: application/json)만 받습니다.' } satisfies ApiErrorBody);
  }
}

/** 사람 로그인(decisions/0050). 세션 토큰은 httpOnly 쿠키로만 준다 — 화면 JS가 읽을 수 없다 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Public()
  @UseGuards(JsonBodyOnly)
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<MeView> {
    const { token, session } = await this.auth.login(dto.loginId, dto.password, readCookie(req.headers.cookie, SESSION_COOKIE));
    // SameSite=Strict: 다른 사이트에서 시작한 요청에는 쿠키가 붙지 않는다(CSRF 막기, decisions/0050). 만료는 서버(Redis TTL)가 정한다
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: env.sessionCookieSecure, path: '/' });
    return toMeView(session);
  }

  @Post('logout')
  @Roles(...ANY_ROLE)
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(readCookie(req.headers.cookie, SESSION_COOKIE));
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: env.sessionCookieSecure, path: '/' });
  }

  @Get('me')
  @Roles(...ANY_ROLE)
  me(@CurrentPrincipal() principal: Principal): MeView {
    return toMeView(principal);
  }
}
