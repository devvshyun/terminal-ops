export type HeartbeatWriteMode = 'redis' | 'mysql';

/**
 * 'mysql'은 실험 0008 비교용 경로다(decisions/0027). 이 모드에서는 Redis lastSeen·firmware가 비어
 * 오프라인 판정·스냅샷·접속 상태 조회(redis 경로)가 하트비트를 보지 못한다. 그래서 운영(NODE_ENV=production)에서는
 * 시작할 때 거절하고, 그 밖에서는 HeartbeatService가 시작할 때 경고를 남긴다.
 */
export const HEARTBEAT_MYSQL_MODE_WARNING =
  'HEARTBEAT_WRITE_MODE=mysql: 실험 0008 비교용 경로입니다. Redis lastSeen·firmware를 쓰지 않아 오프라인 판정·스냅샷·접속 상태 조회가 하트비트를 보지 못합니다(decisions/0027).';

/** HEARTBEAT_WRITE_MODE 값을 읽는다. 'mysql'이 아니면 'redis'. 운영에서 'mysql'이면 던진다(서버가 뜨지 않게). */
export function resolveHeartbeatWriteMode(raw: string | undefined, nodeEnv: string | undefined): HeartbeatWriteMode {
  if (raw !== 'mysql') return 'redis';
  if (nodeEnv === 'production') {
    throw new Error('HEARTBEAT_WRITE_MODE=mysql은 운영(NODE_ENV=production)에서 쓸 수 없습니다. 실험 0008 비교용입니다(decisions/0027).');
  }
  return 'mysql';
}
