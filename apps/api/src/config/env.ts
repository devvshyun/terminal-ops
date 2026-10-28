import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { cronFromEnv } from './env-cron.js';
import { DAY_MS, intFromEnv } from './env-number.js';
import { resolveHeartbeatWriteMode } from './heartbeat-write-mode.js';
import { resolveAuthTestHeaders } from './auth-test-headers.js';
import { checkVanHeartbeatTiming } from '../van/van-limits.js';

// 스크립트·테스트는 apps/api에서 실행한다. 저장소 루트의 .env를 읽는다(이미 있는 환경변수는 덮어쓰지 않는다).
const envFile = resolve(process.cwd(), '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`환경변수 ${name}가 없습니다. 저장소 루트 .env를 확인하세요.`);
  return value;
}

/** 비밀 값(키). 없거나 너무 짧으면 시작할 때 던진다 */
function requiredSecret(name: string, minLength: number): string {
  const value = required(name);
  if (value.length < minLength) throw new Error(`환경변수 ${name}는 ${minLength}자 이상이어야 합니다.`);
  return value;
}

function flag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  return value === undefined ? fallback : value === '1' || value === 'true';
}

const isTest = process.env.NODE_ENV === 'test';

/** 듣는 포트(0은 테스트·도구용 임의 포트) */
const PORT = { min: 0, max: 65_535 };
/** 접속할 포트(MySQL·Redis). 0으로는 접속할 수 없으므로 1부터 */
const CLIENT_PORT = { min: 1, max: 65_535 };
/** 주기·제한 시간(ms): 1ms ~ 하루 */
const MS = { min: 1, max: DAY_MS };
/** 초당 횟수·개수 */
const COUNT = { min: 1, max: 100_000 };
/** 기준일 */
const DAYS = { min: 1, max: 365 };

export const env = {
  port: intFromEnv('API_PORT', 3000, PORT),
  mysql: {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: intFromEnv('MYSQL_PORT', 3306, CLIENT_PORT),
    user: required('MYSQL_USER'),
    password: required('MYSQL_PASSWORD'),
    dbName: isTest ? required('MYSQL_TEST_DATABASE') : required('MYSQL_DATABASE'),
  },
  /** 가상 업체 서버(apps/partners) 주소 */
  partnersUrl: process.env.PARTNERS_URL ?? 'http://127.0.0.1:4010',
  /** 택배사·메신저 호출 타임아웃 */
  partnerTimeoutMs: intFromEnv('PARTNER_TIMEOUT_MS', 3000, MS),
  redis: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: intFromEnv('REDIS_PORT', 6379, CLIENT_PORT),
  },
  /**
   * BullMQ 키 접두사. 테스트는 파일마다 다른 접두사를 써서 다른 파일의 job을 보지 않는다
   * (vitest는 테스트 파일마다 모듈을 새로 읽으므로 이 값도 파일마다 새로 정해진다).
   */
  queuePrefix: process.env.QUEUE_PREFIX ?? (isTest ? `test-${process.pid}-${Date.now()}` : 'terminal-ops'),
  /** 이 프로세스가 큐 job을 처리할지 */
  runWorkers: flag('RUN_WORKERS', true),
  /** 이 프로세스가 주기 작업(수집 sweep, outbox relay)을 등록할지 */
  runSchedulers: flag('RUN_SCHEDULERS', !isTest),
  sweepIntervalMs: intFromEnv('SWEEP_INTERVAL_MS', 30_000, MS),
  relayIntervalMs: intFromEnv('RELAY_INTERVAL_MS', 2_000, MS),
  /** QUEUED outbox 복구(job이 사라진 행에 다시 넣기) 주기와, 만든 지 얼마나 지난 QUEUED 행을 볼지(decisions/0042) */
  outboxRequeueIntervalMs: intFromEnv('OUTBOX_REQUEUE_INTERVAL_MS', 60_000, MS),
  outboxRequeueAfterMs: intFromEnv('OUTBOX_REQUEUE_AFTER_MS', 60_000, MS),
  /** 운영 중 단말기 목록(Redis active)을 MySQL에서 통째로 다시 만드는 주기(decisions/0028) */
  activeRebuildIntervalMs: intFromEnv('ACTIVE_REBUILD_INTERVAL_MS', 60_000, MS),
  /** 하트비트 쓰기 경로. 'mysql'은 실험 0008 비교용(decisions/0027), 운영은 'redis'. NODE_ENV=production에서 'mysql'이면 시작할 때 던진다 */
  heartbeatWriteMode: resolveHeartbeatWriteMode(process.env.HEARTBEAT_WRITE_MODE, process.env.NODE_ENV),
  /** 마지막 하트비트가 이보다 오래되면 오프라인으로 본다(단말기 하트비트 주기 30초의 3배, decisions/0029) */
  hbOfflineAfterMs: intFromEnv('HEARTBEAT_OFFLINE_AFTER_MS', 90_000, MS),
  /** 오프라인 판정 주기 */
  offlineDetectIntervalMs: intFromEnv('OFFLINE_DETECT_INTERVAL_MS', 10_000, MS),
  /** 접속 상태 스냅샷(Redis → MySQL) 주기 */
  connectivitySnapshotIntervalMs: intFromEnv('CONNECTIVITY_SNAPSHOT_INTERVAL_MS', 60_000, MS),
  /** 펌웨어 배포 판단(단계 넘기기·자동 중단·시간 초과)과 제안 맞추기 주기(decisions/0031) */
  rolloutControlIntervalMs: intFromEnv('ROLLOUT_CONTROL_INTERVAL_MS', 5_000, MS),
  /**
   * 한 번 판정에서 오프라인(또는 온라인)으로 바뀐 단말기가 이보다 많으면 단말기별 알림 대신 묶음 알림 한 건
   * (device.offline_bulk/online_bulk)을 남긴다. 5,000건이 relay 줄(2초에 100건)을 100초 막지 않게(decisions/0029, 실험 0010)
   */
  connectivityBulkEventThreshold: intFromEnv('CONNECTIVITY_BULK_EVENT_THRESHOLD', 50, COUNT),
  /** 우리 쪽 호출 속도 제한(초당). 택배사 한도보다 낮게 둔다. */
  bungaeRatePerSec: intFromEnv('BUNGAE_RATE_PER_SEC', 10, COUNT),
  neurimboRatePerSec: intFromEnv('NEURIMBO_RATE_PER_SEC', 5, COUNT),
  /** 알림을 보낼 톡톡메신저 채널 */
  toktokChannel: process.env.TOKTOK_CHANNEL ?? 'ops',
  /**
   * 톡톡메신저가 받는 첨부 크기 상한(바이트). 주간 리포트가 만든 파일이 이보다 크면 올리기 전에 422로 멈춘다(Task 8 리뷰, decisions/0035).
   * 상한은 mediumblob 최대(16,777,215)
   */
  toktokMaxFileBytes: intFromEnv('TOKTOK_MAX_FILE_BYTES', 5 * 1024 * 1024, { min: 1, max: 16_777_215 }),
  /** 박스 스캔 처리 중 잠금(Redis) 유지 시간. 처리가 이보다 길면 잠금이 풀린다(decisions/0020) */
  scanLockTtlMs: intFromEnv('SCAN_LOCK_TTL_MS', 30_000, MS),
  /** A/S 교체 단말기 예약(Redis) 유지 시간. 운송장 발급 + 교체 트랜잭션이 이보다 길면 예약이 풀린다(decisions/0026) */
  replacementLockTtlMs: intFromEnv('REPLACEMENT_LOCK_TTL_MS', 30_000, MS),
  /** 브릿지VAN 등록 목록 한 페이지 크기(F9, decisions/0033) */
  bridgevanPageSize: intFromEnv('BRIDGEVAN_PAGE_SIZE', 500, { min: 1, max: 1000 }),
  /**
   * RUNNING인 VAN 대조 실행의 하트비트(페이지마다 갱신)가 이보다 오래되면 멈춘 것(프로세스가 죽음)으로 보고, 새 실행을 시작할 때 FAILED로 바꾼다.
   * 페이지 하나의 재시도(5번, 지수 백오프·Retry-After)보다 넉넉히 길게 둔다(decisions/0033). 전의 VAN_RUN_STALE_MS(시작 후 경과)를 대신한다
   */
  vanRunHeartbeatStaleMs: intFromEnv('VAN_RUN_HEARTBEAT_STALE_MS', 300_000, MS),
  /** 재검증 때 브릿지VAN 단건 조회를 동시에 몇 개까지 보내나 */
  vanReverifyConcurrency: intFromEnv('VAN_REVERIFY_CONCURRENCY', 8, { min: 1, max: 64 }),
  /**
   * 실행 중 하트비트를 보내는 최소 간격. 확인 지점(수집 페이지·재검증 블록은 항상, 재검증 동시 묶음 사이·재시도 대기 앞은 이 간격이 지났을 때)에서 보낸다.
   * VAN_RUN_HEARTBEAT_STALE_MS ≥ 이 값 + 호출 하나의 최악 시간이어야 한다(시작할 때 검사, van-limits.ts, decisions/0033)
   */
  vanHeartbeatIntervalMs: intFromEnv('VAN_HEARTBEAT_INTERVAL_MS', 30_000, MS),
  /** 안전장치: 후보가 max(이 수, max(수집 수, 우리 운영 중 수) × VAN_CANDIDATE_MAX_PCT%)를 넘으면 재검증 없이 실행을 FAILED로(decisions/0033) */
  vanCandidateAbsCap: intFromEnv('VAN_CANDIDATE_ABS_CAP', 5000, { min: 1, max: 1_000_000 }),
  vanCandidateMaxPct: intFromEnv('VAN_CANDIDATE_MAX_PCT', 20, { min: 1, max: 100 }),
  /**
   * 안전장치: 수집 수가 마지막 COMPLETED 실행의 이 %보다 적거나, 수집 0건인데 우리 운영 중 단말기가 있으면 FAILED로.
   * 0이면 둘 다 검사하지 않는다. 운영자가 확인한 실행(POST 본문 acknowledgeDrop)은 이 검사만 건너뛴다(decisions/0033)
   */
  vanFetchMinPct: intFromEnv('VAN_FETCH_MIN_PCT', 50, { min: 0, max: 100 }),
  /** 대시보드 집계 캐시(Redis) 유지 시간. 화면은 이만큼 전 집계를 볼 수 있다(cachedAt으로 알린다, decisions/0044) */
  dashboardCacheTtlMs: intFromEnv('DASHBOARD_CACHE_TTL_MS', 30_000, MS),
  /** 이상 단말기 찾기(F4) 규칙의 기준일(decisions/0034) */
  anomalyDays: {
    deliveredNotInstalled: intFromEnv('ANOMALY_DELIVERED_DAYS', 7, DAYS),
    returnStalled: intFromEnv('ANOMALY_RETURN_STALLED_DAYS', 14, DAYS),
    shippedTooLong: intFromEnv('ANOMALY_SHIPPED_DAYS', 10, DAYS),
    allocatedNoShipment: intFromEnv('ANOMALY_ALLOCATED_DAYS', 3, DAYS),
    offlineTooLong: intFromEnv('ANOMALY_OFFLINE_DAYS', 3, DAYS),
  },
  /** 한 번 찾기에서 새 이상이 이보다 많으면 단말기별 알림 대신 묶음 한 건(anomaly.detected_bulk, decisions/0034) */
  anomalyBulkEventThreshold: intFromEnv('ANOMALY_BULK_EVENT_THRESHOLD', 20, COUNT),
  /** 주기 작업 cron(분 시 일 월 요일 다섯 칸, 시간대 Asia/Seoul). 잘못된 식이면 env를 읽을 때 던진다(cronFromEnv, decisions/0035) */
  anomalyScanCron: cronFromEnv('ANOMALY_SCAN_CRON', '0 2 * * *'),
  vanReconcileCron: cronFromEnv('VAN_RECONCILE_CRON', '0 3 * * *'),
  /** 주간 리포트(F11): 매주 월요일 09:00 KST에 지난주를 보낸다 */
  weeklyReportCron: cronFromEnv('WEEKLY_REPORT_CRON', '0 9 * * 1'),
  /** 로그인 세션(Redis)이 쓰이지 않고 이만큼 지나면 끝난다. 요청마다 다시 늘린다(decisions/0050). 기본 8시간 */
  sessionIdleTtlMs: intFromEnv('SESSION_IDLE_TTL_MS', 8 * 60 * 60_000, MS),
  /** 로그인부터 이만큼 지나면 쓰고 있어도 끝난다(절대 만료, decisions/0050). 기본 7일 */
  sessionMaxAgeMs: intFromEnv('SESSION_MAX_AGE_MS', 7 * DAY_MS, { min: 60_000, max: 90 * DAY_MS }),
  /** 세션 쿠키에 Secure를 붙일지. 로컬 http 시연은 0, https 뒤에 둘 때 1(decisions/0050) */
  sessionCookieSecure: flag('SESSION_COOKIE_SECURE', false),
  /** 같은 아이디로 로그인 실패가 이만큼 쌓이면 LOGIN_LOCK_MS 동안 막는다(첫 실패부터 잰다, decisions/0050) */
  loginMaxFailures: intFromEnv('LOGIN_MAX_FAILURES', 5, { min: 1, max: 100 }),
  loginLockMs: intFromEnv('LOGIN_LOCK_MS', 15 * 60_000, MS),
  /** 단말기(시뮬레이터)가 `X-Device-Key`로 보내는 공유 키. 16자 이상(decisions/0055) */
  deviceApiKey: requiredSecret('DEVICE_API_KEY', 16),
  /** 테스트 전용 인증 헤더(X-Operator·X-Test-Role). NODE_ENV=test가 아니면 켜지지 않고 던진다(decisions/0056) */
  authTestHeaders: resolveAuthTestHeaders(process.env.AUTH_TEST_HEADERS, process.env.NODE_ENV),
  /** SyncRun에 남길 작업 프로세스 이름(워커 2개 실험에서 구분용) */
  workerName: process.env.WORKER_NAME ?? `pid-${process.pid}`,
};

// VAN 실행의 멈춤 기준이 하트비트 간격·호출 하나의 최악 시간보다 짧으면 살아 있는 실행을 다른 시작이 FAILED로 바꾼다 → 시작 실패(decisions/0033)
checkVanHeartbeatTiming({ staleMs: env.vanRunHeartbeatStaleMs, intervalMs: env.vanHeartbeatIntervalMs, timeoutMs: env.partnerTimeoutMs });
