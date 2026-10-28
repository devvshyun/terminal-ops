import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { OffsetPage, PartnerTerminalView } from '@terminal-ops/contracts';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PartnerAuth } from '../auth/access.js';
import { Merchant } from '../merchant/merchant.entity.js';
import type { Terminal } from '../terminal/terminal.entity.js';
import { TerminalService } from '../terminal/terminal.service.js';

export class PartnerPageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size: number = 50;
}

function toPartnerTerminalView(t: Terminal): PartnerTerminalView {
  return { serialNo: t.serialNo, modelCode: t.model.code, status: t.status, merchantCode: t.merchant?.code ?? null };
}

/**
 * 외부 업체용 읽기 API(decisions/0054). 사람 세션이 아니라 `Authorization: Bearer <키>` 또는 `X-Api-Key`로 받고, 키의 scope마다 열린다.
 * 응답은 사내 TerminalView보다 좁다(version·시각 없음) — 외부에 내보낼 필드만. 경로에 버전(v1)을 둔다(사내 API와 따로 바꾸게).
 */
@Controller('partner/v1')
export class PartnerApiController {
  constructor(
    private readonly terminals: TerminalService,
    private readonly em: EntityManager,
  ) {}

  @Get('terminals/:serialNo')
  @PartnerAuth('terminal-status:read')
  async terminal(@Param('serialNo') serialNo: string): Promise<PartnerTerminalView> {
    return toPartnerTerminalView(await this.terminals.getBySerial(serialNo));
  }

  @Get('merchants/:merchantCode/terminals')
  @PartnerAuth('merchant-terminals:read')
  async merchantTerminals(@Param('merchantCode') merchantCode: string, @Query() q: PartnerPageQuery): Promise<OffsetPage<PartnerTerminalView>> {
    if (!(await this.em.fork().count(Merchant, { code: merchantCode }))) throw new NotFoundException(`가맹점 ${merchantCode}이(가) 없습니다.`);
    const result = await this.terminals.list({ merchantCode, page: q.page, size: q.size });
    return { ...result, items: result.items.map(toPartnerTerminalView) };
  }
}
