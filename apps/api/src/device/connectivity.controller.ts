import { Controller, Get, Param } from '@nestjs/common';
import { OFFICE, Roles } from '../auth/access.js';
import { ConnectivityService } from './connectivity.service.js';

@Controller('terminals')
export class ConnectivityController {
  constructor(private readonly connectivity: ConnectivityService) {}

  /** 접속 상태: Redis(최신 하트비트)가 있으면 그것, 없으면 MySQL 스냅샷(decisions/0029) */
  @Get(':serialNo/connectivity')
  @Roles(...OFFICE)
  async get(@Param('serialNo') serialNo: string) {
    return this.connectivity.get(serialNo);
  }
}
