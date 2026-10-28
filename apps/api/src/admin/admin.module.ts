import { Module } from '@nestjs/common';
import { AdminAccountsController, AdminPartnerKeysController } from './admin.controllers.js';

/** ADMIN 전용 API(계정, 외부 업체 키). 서비스는 AuthModule(전역)에 있다 */
@Module({
  controllers: [AdminAccountsController, AdminPartnerKeysController],
})
export class AdminModule {}
