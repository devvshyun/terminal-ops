/**
 * 운영 관제(보강 6, decisions/0070). `GET /ops/...`는 관제·ADMIN이 읽고, 관제 작업(다시 시도·지우기·복구 sweep)은 관제(MONITOR)만 한다.
 * 큐·주기 작업·워커 상태는 BullMQ(Redis)에서, Outbox·업무 오류·감사 기록은 MySQL에서 그때그때 읽는다(캐시 없음).
 */

/** BullMQ 큐 이름(api queue-names.ts QUEUE와 같은 값 — api contract-assertions.ts가 단언) */
export type OpsQueueName = 'track-bungae' | 'track-neurimbo' | 'carrier-sweep' | 'outbox' | 'device' | 'report';

/**
 * 큐의 상태별 job 수. BullMQ는 큐를 멈춰도(Queue.pause) job을 waiting에 그대로 센다 — 멈춤은 `paused` 플래그로 본다(사전 검증).
 * completed·failed는 Redis에 남은 것만 센다 — 이 시스템의 job 대부분은 끝나면 지워진다(removeOnComplete·removeOnFail, decisions/0072).
 */
export interface OpsJobCounts {
  waiting: number;
  active: number;
  delayed: number;
  prioritized: number;
  failed: number;
  completed: number;
}

/** 큐 하나의 요약(GET /ops/queues) */
export interface OpsQueueView {
  name: OpsQueueName;
  counts: OpsJobCounts;
  /** 큐 전체가 멈춤(Queue.pause)인가 */
  paused: boolean;
  /** 가장 오래 기다린(waiting) job이 들어온 시각. 기다리는 job이 없으면 null */
  oldestWaitingAt: string | null;
  /** 최근 recentMinutes분(지금 분 포함) 동안 끝난·실패한 job 수(BullMQ 분 단위 metrics). 워커가 아직 한 번도 기록하지 않았으면 null(decisions/0071) */
  completedRecent: number | null;
  /** 마지막으로 실패한 job만 센다(attempts를 다 쓴 최종 실패) — 재시도로 이어진 중간 실패는 들어가지 않는다 */
  failedRecent: number | null;
  /** 이 큐를 처리하는 워커 연결 수(BullMQ getWorkers — Redis CLIENT LIST) */
  workers: number;
}

export interface OpsQueuesView {
  checkedAt: string;
  recentMinutes: number;
  queues: OpsQueueView[];
}

/** 주기 작업 하나(GET /ops/schedulers) — 코드의 목록(JOB_SCHEDULERS)과 Redis에 등록된 것을 합친다 */
export interface OpsSchedulerView {
  id: string;
  queue: OpsQueueName;
  jobName: string;
  /** 간격(ms) — cron이면 null */
  every: number | null;
  /** cron 식과 시간대 — 간격이면 null */
  pattern: string | null;
  tz: string | null;
  /** 코드의 주기 작업 목록에 있나. false면 Redis에만 남은 것(이름을 바꾸기 전 것 등 — scheduler:clear 대상이 아니다) */
  defined: boolean;
  /** Redis에 등록돼 있나. false면 RUN_SCHEDULERS=1인 프로세스가 아직 뜨지 않았거나 scheduler:clear로 지운 것 */
  registered: boolean;
  /** 다음 실행 시각(등록된 것만) */
  nextRunAt: string | null;
}

/** 의존 서비스 하나의 응답(MySQL `select 1`, Redis PING) */
export interface OpsDependencyView {
  ok: boolean;
  latencyMs: number | null;
  /** 오류 이름과 코드만(`Error ECONNREFUSED`, 2초 안에 답이 없으면 `TIMEOUT`). 호스트·포트가 든 메시지는 보내지 않는다 */
  error: string | null;
}

/** 큐를 처리하는 워커 연결 하나(BullMQ getWorkers) */
export interface OpsWorkerView {
  queue: OpsQueueName;
  /** 워커 이름(api WORKER_NAME, 없으면 pid-<pid>). 이름 없이 뜬 워커는 null */
  name: string | null;
  /** 마지막 명령 뒤 지난 초(Redis CLIENT LIST idle) */
  idleSeconds: number;
}

/** 프로세스·의존 상태(GET /ops/system) */
export interface OpsSystemView {
  checkedAt: string;
  api: {
    /** APP_VERSION env(없으면 'dev') */
    version: string;
    startedAt: string;
    node: string;
    queuePrefix: string;
    runWorkers: boolean;
    runSchedulers: boolean;
  };
  mysql: OpsDependencyView;
  redis: OpsDependencyView;
  workers: OpsWorkerView[];
}

/** Outbox 행 상태(api OutboxStatus와 같은 값 — contract-assertions.ts, decisions/0016) */
export type OpsOutboxStatus = 'PENDING' | 'QUEUED' | 'SENT' | 'FAILED';

/** Outbox 요약(GET /ops/outbox) */
export interface OpsOutboxView {
  checkedAt: string;
  counts: Record<OpsOutboxStatus, number>;
  /** 가장 오래된 PENDING·QUEUED 행을 만든 시각(없으면 null). PENDING이 오래되면 relay가 멈춘 것, QUEUED가 오래되면 notify job이 사라졌거나 밀린 것 */
  oldestPendingAt: string | null;
  oldestQueuedAt: string | null;
  /** 복구 sweep은 만든 지 이만큼 지난 QUEUED 행만 본다(OUTBOX_REQUEUE_AFTER_MS, decisions/0042) */
  requeueAfterMs: number;
}

/** 최근 업무 오류의 출처 — 새 표 없이 오류를 이미 남기는 기록을 읽는다(decisions/0070) */
export type OpsErrorSource = 'SYNC_RUN' | 'VAN_RUN' | 'WEEKLY_REPORT' | 'OUTBOX';

/** 최근 업무 오류 한 건(GET /ops/errors) */
export interface OpsErrorView {
  source: OpsErrorSource;
  /** 그 표의 행 id */
  id: number;
  /**
   * 기록 시각: 수집 기록은 시작 시각, VAN 대조는 끝난 시각(없으면 시작), 주간 리포트는 파일을 만든 시각(없으면 행을 만든 시각 — 실패 시각 열이 없다),
   * outbox는 행을 만든 시각(마지막 시도 시각 열이 없다)
   */
  at: string;
  title: string;
  /** 그 행에 남은 오류 글(500자까지) */
  message: string;
}

/**
 * 실패한 job 하나(GET /ops/queues/:name/failed). Redis에 남은 실패만 보인다 — 끝나면 지우는 job(removeOnFail: true)의 실패는
 * 업무 기록(outbox FAILED, 수집 기록 ERROR, 주간 리포트 lastError)으로 본다(GET /ops/errors, decisions/0072).
 */
export interface OpsFailedJobView {
  queue: OpsQueueName;
  /** BullMQ job id(주기 job은 `repeat:<id>:<시각>`) */
  id: string;
  name: string;
  /** job data — 비밀·개인정보처럼 보이는 이름의 값은 '[가림]', 긴 글자는 자른다(decisions/0072) */
  data: Record<string, unknown>;
  /** 마지막 실패 이유(500자까지). 스택은 보내지 않는다 */
  failedReason: string;
  attemptsMade: number;
  /** job 옵션의 최대 시도 수(없으면 1) */
  maxAttempts: number;
  createdAt: string;
  failedAt: string | null;
}

/** 실패 job 목록 한 쪽(최근 실패부터 start번째부터 limit개). total = 이 큐의 실패 job 수 */
export interface OpsFailedJobsPage {
  items: OpsFailedJobView[];
  total: number;
  start: number;
  limit: number;
}

/** 관제 작업 종류(감사 기록, decisions/0073) */
export type OpsActionKind = 'RETRY_JOB' | 'REMOVE_JOB' | 'REQUEUE_OUTBOX';

/** 관제 작업 한 건의 감사 기록(GET /ops/actions, 최근부터 beforeId 키셋) */
export interface OpsActionView {
  id: number;
  action: OpsActionKind;
  /** 로그인 아이디와 그때의 역할 */
  actor: string;
  actorRole: string;
  queue: OpsQueueName | null;
  jobId: string | null;
  jobName: string | null;
  /** 작업 때의 사정(job의 실패 이유·시도 수, sweep 결과 수) */
  detail: Record<string, unknown> | null;
  createdAt: string;
}

/** POST /ops/queues/:name/jobs/:id/retry·remove 응답 */
export interface OpsJobActionResult {
  queue: OpsQueueName;
  jobId: string;
  action: 'RETRY_JOB' | 'REMOVE_JOB';
  /** 남긴 감사 기록 id */
  actionId: number;
}

/** POST /ops/outbox/requeue — 멈춘 QUEUED 복구 sweep을 지금 한 번(주기 작업 outbox-requeue와 같은 일, decisions/0042) */
export interface OpsRequeueResult {
  /** 본 QUEUED 행 수(최대 100) */
  checked: number;
  /** notify job이 없어 다시 넣은 outbox id */
  requeued: number[];
  actionId: number;
}
