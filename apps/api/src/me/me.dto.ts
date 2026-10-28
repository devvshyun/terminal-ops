import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { BeforeIdQuery } from '../common/keyset.js';
import { MERCHANT_VISIBLE_STATUSES } from '../merchant/merchant-scope.js';
import { ServiceTicketStatus } from '../service/service-ticket.entity.js';
import { TerminalStatus } from '../terminal/terminal-status.js';

/**
 * GET /me/terminals — 가맹점 조건(merchantCode)은 받지 않는다(로그인한 가맹점으로 정해진다, 보내면 400).
 * 상태 조건은 점주에게 보이는 상태만(MERCHANT_VISIBLE_STATUSES, 그 밖이면 400 — decisions/0059)
 */
export class MeTerminalsQuery {
  @IsOptional()
  @IsIn(MERCHANT_VISIBLE_STATUSES)
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

  /** 고장 접수된 단말기 시리얼(정확히 같은 것) — 단말기 상세 화면의 "이 단말기의 A/S"(보강 3) */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  serialNo?: string;
}
