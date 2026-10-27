import { IsIn, IsOptional } from 'class-validator';
import { BeforeIdQuery } from '../../common/keyset.js';
import { QUEUE } from '../../queue/queue-names.js';
import { SYNC_RUN_OUTCOMES, type SyncRunOutcome } from '../shipment.entities.js';

/** SyncRun을 남기는 큐(택배 추적). 오타가 빈 목록으로 보이지 않게 정해진 값만 받는다 */
export const SYNC_RUN_JOBS = [QUEUE.TRACK_BUNGAE, QUEUE.TRACK_NEURIMBO] as const;

/** GET /sync-runs 조건(최근 실행부터, decisions/0039) */
export class ListSyncRunsQuery extends BeforeIdQuery {
  /** 큐 이름(track-bungae, track-neurimbo) */
  @IsOptional()
  @IsIn(SYNC_RUN_JOBS)
  job?: string;

  /** OK | DELIVERED | NOOP | SKIPPED | ERROR */
  @IsOptional()
  @IsIn(SYNC_RUN_OUTCOMES)
  outcome?: SyncRunOutcome;
}
