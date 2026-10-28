import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { BeforeIdQuery } from '../common/keyset.js';
import { ServiceTicketStatus } from '../service/service-ticket.entity.js';
import { TerminalStatus } from '../terminal/terminal-status.js';

/** GET /me/terminals — 가맹점 조건(merchantCode)은 받지 않는다(로그인한 가맹점으로 정해진다, 보내면 400) */
export class MeTerminalsQuery {
  @IsOptional()
  @IsEnum(TerminalStatus)
  status?: TerminalStatus;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Math.floor(Number.MAX_SAFE_INTEGER / 100))
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size: number = 20;
}

/** GET /me/service-tickets — 내 가맹점 접수만(최근 것부터) */
export class MeTicketsQuery extends BeforeIdQuery {
  @IsOptional()
  @IsEnum(ServiceTicketStatus)
  status?: ServiceTicketStatus;
}
