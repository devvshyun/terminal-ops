import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { DeviceAuth } from '../auth/access.js';
import { HeartbeatBatchDto } from './dto/heartbeat.dto.js';
import { HeartbeatService } from './heartbeat.service.js';

/** 단말기가 부르는 API. 사람이 아니라 단말기라서 로그인 세션이 아니라 단말기 키로 받는다(decisions/0055). 형식은 행마다 검사한다. */
@Controller('devices')
export class DeviceController {
  constructor(private readonly heartbeats: HeartbeatService) {}

  /** 하트비트 묶음(1~500개). 항목마다 결과를 돌려준다. 단건은 항목 1개짜리 묶음으로 보낸다. */
  @Post('heartbeats')
  @DeviceAuth()
  @HttpCode(200)
  async heartbeat(@Body() dto: HeartbeatBatchDto) {
    return this.heartbeats.receive(dto.items);
  }
}
