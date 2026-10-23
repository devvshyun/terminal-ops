import { env } from '../config/env.js';

/**
 * 접속 상태(F8)의 Redis 키(decisions/0027). 큐와 같은 접두사를 붙여 테스트(test-…)와 개발(terminal-ops)을 나눈다.
 * - lastSeen  ZSET  serialNo → 마지막 하트비트 시각(ms, 서버 시계)
 * - firmware  HASH  serialNo → 마지막으로 보고한 펌웨어 버전
 * - active    HASH  serialNo → terminal.id (IN_SERVICE 단말기만. 하트비트를 받을지 가르는 기준, decisions/0028)
 * - offline   SET   serialNo (오프라인으로 기록해 둔 단말기, decisions/0029)
 * - snapshotAt STRING 마지막 스냅샷이 반영한 lastSeen 점수(ms)
 * - offers    HASH  serialNo → {"rolloutId":n,"version":"…"} (펌웨어 업데이트 제안, decisions/0030)
 */
export function deviceKeys() {
  const p = env.queuePrefix;
  return {
    lastSeen: `${p}:hb:lastseen`,
    firmware: `${p}:hb:fw`,
    active: `${p}:hb:active`,
    offline: `${p}:hb:offline`,
    snapshotAt: `${p}:hb:snapshot-at`,
    offers: `${p}:fw:offers`,
  };
}
