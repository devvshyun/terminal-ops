import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { HeartbeatBatchDto } from './dto/heartbeat.dto.js';
import { HeartbeatService } from './heartbeat.service.js';

/**
 * 단말기가 부르는 API. 사람이 아니라 단말기라서 작업자 헤더(X-Operator)를 받지 않는다.
 * 단말기 인증도 이번에는 하지 않는다(가상 프로젝트, decisions/0001과 같은 이유로 미룸). 대신 형식을 검사한다.
 */
@Controller('devices')
export class DeviceController {
  constructor(private readonly heartbeats: HeartbeatService) {}

  /** 하트비트 묶음(1~500개). 항목마다 결과를 돌려준다. 단건은 항목 1개짜리 묶음으로 보낸다. */
  @Post('heartbeats')
  @HttpCode(200)
  async heartbeat(@Body() dto: HeartbeatBatchDto) {
    return this.heartbeats.receive(dto.items);
  }
}
