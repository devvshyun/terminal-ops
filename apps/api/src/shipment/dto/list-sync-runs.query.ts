import { IsOptional, IsString, MaxLength } from 'class-validator';
import { BeforeIdQuery } from '../../common/keyset.js';

/** GET /sync-runs 조건(최근 실행부터, decisions/0039) */
export class ListSyncRunsQuery extends BeforeIdQuery {
  /** 큐 이름(track-bungae, track-neurimbo) */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  job?: string;

  /** OK | DELIVERED | NOOP | SKIPPED | ERROR */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  outcome?: string;
}
