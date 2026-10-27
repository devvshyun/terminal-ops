import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { TerminalStatus } from '../terminal-status.js';

export class ListTerminalsQuery {
  @IsOptional()
  @IsEnum(TerminalStatus)
  status?: TerminalStatus;

  @IsOptional()
  @IsString()
  modelCode?: string;

  /** 배정 가맹점 코드 */
  @IsOptional()
  @IsString()
  merchantCode?: string;

  /** 시리얼 앞부분(시리얼은 32자까지라 그보다 긴 검색어는 받지 않는다) */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  q?: string;

  /** offset = (page - 1) × size(최대 100)가 안전한 정수(2^53-1) 안에 들게 상한을 둔다 — 넘으면 offset이 뭉개져 MySQL까지 가서 500(Day 6 최종 리뷰 Minor 11) */
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
