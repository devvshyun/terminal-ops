import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { env } from '../config/env.js';
import { QUEUE } from '../queue/queue-names.js';
import { CarrierSyncService, type TrackJobData } from './carrier-sync.service.js';
import { carrierBackoff, toJobError } from './retry-policy.js';

async function runTrack(sync: CarrierSyncService, queue: string, job: Job<TrackJobData>) {
  try {
    return await sync.track(job.data.shipmentId, { queue, attempt: job.attemptsMade + 1 });
  } catch (error) {
    throw toJobError(error);
  }
}

/** 번개택배 추적. limiter로 우리 쪽 호출 속도를 택배사 한도 아래로 묶는다(초당 env.bungaeRatePerSec). */
@Processor(QUEUE.TRACK_BUNGAE, {
  concurrency: 5,
  limiter: { max: env.bungaeRatePerSec, duration: 1000 },
  settings: { backoffStrategy: carrierBackoff },
})
export class BungaeTrackProcessor extends WorkerHost {
  constructor(private readonly sync: CarrierSyncService) {
    super();
  }

  process(job: Job<TrackJobData>) {
    return runTrack(this.sync, QUEUE.TRACK_BUNGAE, job);
  }
}

/** 느림보물류 추적. 응답이 느려 동시 처리 수를 조금 더 둔다. */
@Processor(QUEUE.TRACK_NEURIMBO, {
  concurrency: 5,
  limiter: { max: env.neurimboRatePerSec, duration: 1000 },
  settings: { backoffStrategy: carrierBackoff },
})
export class NeurimboTrackProcessor extends WorkerHost {
  constructor(private readonly sync: CarrierSyncService) {
    super();
  }

  process(job: Job<TrackJobData>) {
    return runTrack(this.sync, QUEUE.TRACK_NEURIMBO, job);
  }
}

/** 주기 실행(job scheduler)이 넣는 sweep job을 처리한다. */
@Processor(QUEUE.CARRIER_SWEEP)
export class CarrierSweepProcessor extends WorkerHost {
  constructor(private readonly sync: CarrierSyncService) {
    super();
  }

  process() {
    return this.sync.sweep();
  }
}
