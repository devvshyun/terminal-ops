import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccountService } from './account.service.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { PartnerKeyService } from './partner-key.service.js';
import { SessionStore } from './session.store.js';

/** 로그인·세션·가드(보강 2). 가드는 앱 전체(APP_GUARD) — 모든 핸들러가 접근 규칙을 가져야 한다(decisions/0052) */
@Global()
@Module({
  controllers: [AuthController],
  providers: [SessionStore, AuthService, AccountService, PartnerKeyService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [SessionStore, AccountService, PartnerKeyService],
})
export class AuthModule {}
