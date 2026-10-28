import { Controller, Get } from '@nestjs/common';
import type { FieldTodayView } from '@terminal-ops/contracts';
import { Roles } from '../auth/access.js';
import { Role } from '../auth/role.js';
import { Operator } from '../common/operator.decorator.js';
import { FieldService } from './field.service.js';

/**
 * 현장 작업자 화면 전용(보강 4, decisions/0063). 스캔·검수는 기존 API(OPERATOR·FIELD)를 그대로 쓰고, 여기에는 현장 화면에만 필요한 것만 둔다.
 * 쓰는 화면이 현장 앱 하나라 FIELD만 연다(표 decisions/0052).
 */
@Controller('field')
export class FieldController {
  constructor(private readonly field: FieldService) {}

  /** 오늘(KST) 내가 처리한 박스·단말기·검수 수 */
  @Get('today')
  @Roles(Role.FIELD)
  async today(@Operator() actor: string): Promise<FieldTodayView> {
    return this.field.today(actor);
  }
}
