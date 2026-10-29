import { Module } from '@nestjs/common';
import { PartnerService } from '../partner/partner.service.js';
import { AdminAccountsController, AdminPartnerCallsController, AdminPartnerKeysController, AdminPartnersController } from './admin.controllers.js';

/** ADMIN 전용 API(계정, 외부 업체, 외부 업체 키). 계정·키 서비스는 AuthModule(전역)에 있다 */
@Module({
  controllers: [AdminAccountsController, AdminPartnersController, AdminPartnerKeysController, AdminPartnerCallsController],
  providers: [PartnerService],
})
export class AdminModule {}
