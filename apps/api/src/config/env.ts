import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DAY_MS, intFromEnv } from './env-number.js';
import { resolveHeartbeatWriteMode } from './heartbeat-write-mode.js';

// 스크립트·테스트는 apps/api에서 실행한다. 저장소 루트의 .env를 읽는다(이미 있는 환경변수는 덮어쓰지 않는다).
const envFile = resolve(process.cwd(), '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`환경변수 ${name}가 없습니다. 저장소 루트 .env를 확인하세요.`);
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
  /** SyncRun에 남길 작업 프로세스 이름(워커 2개 실험에서 구분용) */
  workerName: process.env.WORKER_NAME ?? `pid-${process.pid}`,
};
