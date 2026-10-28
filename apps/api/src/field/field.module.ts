import { Module } from '@nestjs/common';
import { FieldController } from './field.controller.js';
import { FieldService } from './field.service.js';

/** 현장 작업자 화면용 API `/field/...`(보강 4, decisions/0063) */
@Module({
  controllers: [FieldController],
  providers: [FieldService],
})
export class FieldModule {}
