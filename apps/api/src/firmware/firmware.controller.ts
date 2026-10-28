import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import type { BeforeIdPage, RolloutView } from '@terminal-ops/contracts';
import { OFFICE, Roles } from '../auth/access.js';
import { Role } from '../auth/role.js';
import { Operator } from '../common/operator.decorator.js';
import { CreateRolloutDto, ListRolloutsQuery, RegisterFirmwareDto } from './dto/firmware.dto.js';
import { FirmwareService, toFirmwareView } from './firmware.service.js';
import { RolloutService, toRolloutView } from './rollout.service.js';
import type { FirmwareRollout } from './firmware.entities.js';

/** 펌웨어 등록과 단계 배포 관리. 쓰기는 운영자(OPERATOR)만(decisions/0052). */
@Controller()
export class FirmwareController {
  constructor(
    private readonly firmware: FirmwareService,
    private readonly rollouts: RolloutService,
  ) {}

  @Post('firmware')
  @Roles(Role.OPERATOR)
  async register(@Body() dto: RegisterFirmwareDto, @Operator() actor: string) {
    return toFirmwareView(await this.firmware.register(dto, actor));
  }

  @Post('firmware-rollouts')
  @Roles(Role.OPERATOR)
  async create(@Body() dto: CreateRolloutDto, @Operator() actor: string) {
    return this.view(await this.rollouts.create(dto, actor));
  }

  /** 배포 목록과 단계별 통계(최근 것부터, ?status=&beforeId=&limit=) */
  @Get('firmware-rollouts')
  @Roles(...OFFICE)
  async list(@Query() query: ListRolloutsQuery): Promise<BeforeIdPage<RolloutView>> {
    const { items, nextBeforeId } = await this.rollouts.list(query);
    return { items: items.map(({ rollout, stats }) => toRolloutView(rollout, stats)), nextBeforeId };
  }

  @Get('firmware-rollouts/:id')
  @Roles(...OFFICE)
  async get(@Param('id', ParseIntPipe) id: number) {
    return this.view(await this.rollouts.get(id));
  }

  @Post('firmware-rollouts/:id/pause')
  @Roles(Role.OPERATOR)
  @HttpCode(200)
  async pause(@Param('id', ParseIntPipe) id: number, @Operator() _actor: string) {
    return this.view(await this.rollouts.pause(id));
  }

  @Post('firmware-rollouts/:id/resume')
  @Roles(Role.OPERATOR)
  @HttpCode(200)
  async resume(@Param('id', ParseIntPipe) id: number, @Operator() _actor: string) {
    return this.view(await this.rollouts.resume(id));
  }

  @Post('firmware-rollouts/:id/abort')
  @Roles(Role.OPERATOR)
  @HttpCode(200)
  async abort(@Param('id', ParseIntPipe) id: number, @Operator() actor: string) {
    return this.view(await this.rollouts.abort(id, actor));
  }

  private async view(rollout: FirmwareRollout) {
    return toRolloutView(rollout, await this.rollouts.stageStats(rollout));
  }
}
