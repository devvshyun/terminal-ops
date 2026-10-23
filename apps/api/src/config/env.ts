import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

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

export const env = {
  port: Number(process.env.API_PORT ?? 3000),
  mysql: {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: required('MYSQL_USER'),
    password: required('MYSQL_PASSWORD'),
    dbName: isTest ? required('MYSQL_TEST_DATABASE') : required('MYSQL_DATABASE'),
  },
  /** 가상 업체 서버(apps/partners) 주소 */
  partnersUrl: process.env.PARTNERS_URL ?? 'http://127.0.0.1:4010',
  /** 택배사·메신저 호출 타임아웃 */
  partnerTimeoutMs: Number(process.env.PARTNER_TIMEOUT_MS ?? 3000),
  redis: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
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
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS ?? 30_000),
  relayIntervalMs: Number(process.env.RELAY_INTERVAL_MS ?? 2_000),
  /** 운영 중 단말기 목록(Redis active)을 MySQL에서 통째로 다시 만드는 주기(decisions/0028) */
  activeRebuildIntervalMs: Number(process.env.ACTIVE_REBUILD_INTERVAL_MS ?? 60_000),
  /** 마지막 하트비트가 이보다 오래되면 오프라인으로 본다(단말기 하트비트 주기 30초의 3배, decisions/0029) */
  hbOfflineAfterMs: Number(process.env.HEARTBEAT_OFFLINE_AFTER_MS ?? 90_000),
  /** 오프라인 판정 주기 */
  offlineDetectIntervalMs: Number(process.env.OFFLINE_DETECT_INTERVAL_MS ?? 10_000),
  /** 접속 상태 스냅샷(Redis → MySQL) 주기 */
  connectivitySnapshotIntervalMs: Number(process.env.CONNECTIVITY_SNAPSHOT_INTERVAL_MS ?? 60_000),
  /** 우리 쪽 호출 속도 제한(초당). 택배사 한도보다 낮게 둔다. */
  bungaeRatePerSec: Number(process.env.BUNGAE_RATE_PER_SEC ?? 10),
  neurimboRatePerSec: Number(process.env.NEURIMBO_RATE_PER_SEC ?? 5),
  /** 알림을 보낼 톡톡메신저 채널 */
  toktokChannel: process.env.TOKTOK_CHANNEL ?? 'ops',
  /** 박스 스캔 처리 중 잠금(Redis) 유지 시간. 처리가 이보다 길면 잠금이 풀린다(decisions/0020) */
  scanLockTtlMs: Number(process.env.SCAN_LOCK_TTL_MS ?? 30_000),
  /** A/S 교체 단말기 예약(Redis) 유지 시간. 운송장 발급 + 교체 트랜잭션이 이보다 길면 예약이 풀린다(decisions/0026) */
  replacementLockTtlMs: Number(process.env.REPLACEMENT_LOCK_TTL_MS ?? 30_000),
  /** SyncRun에 남길 작업 프로세스 이름(워커 2개 실험에서 구분용) */
  workerName: process.env.WORKER_NAME ?? `pid-${process.pid}`,
};
