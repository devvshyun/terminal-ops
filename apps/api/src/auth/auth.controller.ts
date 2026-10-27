import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { MeView } from '@terminal-ops/contracts';
import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { ANY_ROLE, Public, Roles } from './access.js';
import { AuthService } from './auth.service.js';
import { readCookie, SESSION_COOKIE } from './cookies.js';
import { LoginDto } from './dto/login.dto.js';
import { CurrentPrincipal, toMeView, type Principal } from './principal.js';

/** 사람 로그인(decisions/0050). 세션 토큰은 httpOnly 쿠키로만 준다 — 화면 JS가 읽을 수 없다 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response): Promise<MeView> {
    const { token, session } = await this.auth.login(dto.loginId, dto.password);
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
