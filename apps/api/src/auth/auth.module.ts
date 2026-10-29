import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccountService } from './account.service.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { PartnerCallService } from '../partner/partner-call.service.js';
import { PartnerKeyService } from './partner-key.service.js';
import { SessionStore } from './session.store.js';

/** 로그인·세션·가드(보강 2). 외부용 API 호출 기록(보강 7)도 가드가 걸어 여기 둔다. 가드는 앱 전체(APP_GUARD) — 모든 핸들러가 접근 규칙을 가져야 한다(decisions/0052) */
@Global()
@Module({
  controllers: [AuthController],
  providers: [SessionStore, AuthService, AccountService, PartnerKeyService, PartnerCallService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [SessionStore, AccountService, PartnerKeyService, PartnerCallService],
})
export class AuthModule {}
