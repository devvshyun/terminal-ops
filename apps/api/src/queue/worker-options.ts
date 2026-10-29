import { env } from '../config/env.js';

/** 워커가 남기는 분 단위 처리 수(BullMQ metrics)를 몇 분치 둘까 — 하루. 큐마다 completed·failed 목록 두 개, 1,440칸씩 */
export const METRICS_MAX_DATA_POINTS = 24 * 60;

/**
 * 모든 @Processor에 붙이는 관찰용 워커 옵션(보강 6, decisions/0071).
 * - name: Redis 연결 이름에 붙어(`<접두사>:<큐 base64>:w:<이름>`) 운영 관제가 `getWorkers()`로 어느 프로세스가 이 큐를 처리하는지 본다
 * - metrics: job이 끝날 때마다 분 단위 완료·실패 수를 Redis에 쌓는다(job을 지워도 — removeOnComplete — 센다). 관제의 "최근 15분 처리량"
 */
export const WORKER_OBSERVABILITY = {
  name: env.workerName,
  metrics: { maxDataPoints: METRICS_MAX_DATA_POINTS },
};
