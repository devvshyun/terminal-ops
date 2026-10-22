import { Module } from '@nestjs/common';
import { TerminalModule } from '../terminal/terminal.module.js';
import { MerchantController } from './merchant.controller.js';
import { MerchantService } from './merchant.service.js';

@Module({
  imports: [TerminalModule],
  controllers: [MerchantController],
  providers: [MerchantService],
})
export class MerchantModule {}
