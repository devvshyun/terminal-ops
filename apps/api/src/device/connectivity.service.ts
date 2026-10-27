import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { raw } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/mysql';
import type { Redis } from 'ioredis';
import type { ConnectivityView } from '@terminal-ops/contracts';
import { env } from '../config/env.js';
import { OUTBOX_TYPE, OutboxEvent } from '../outbox/outbox-event.entity.js';
import { execOrThrow } from '../redis/redis-exec.js';
import { RedisLock } from '../redis/redis-lock.js';
import { REDIS } from '../redis/redis.provider.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { DeviceConnectivity } from './device-connectivity.entity.js';
import { deviceKeys } from './device-keys.js';

/** 주기 작업 잠금 유지 시간. 작업 하나가 이보다 오래 걸리면 다음 작업이 겹칠 수 있다 */
const JOB_LOCK_TTL_MS = 30_000;

export interface DetectResult {
  /** 이번에 오프라인이 된 단말기 */
  offline: string[];
  /** 이번에 온라인으로 돌아온 단말기 */
  online: string[];
  /** 다른 프로세스가 판정 중이라 건너뜀 */
  skipped?: boolean;
}

export type ConnectivityRow = Pick<DeviceConnectivity, 'terminalId' | 'online' | 'lastSeenAt' | 'firmwareVersion' | 'changedAt'>;

/** UPSERT 한 문장에 담는 행 수 */
const UPSERT_CHUNK = 500;

/** 묶음 알림(device.offline_bulk/online_bulk) payload에 담는 시리얼 수. 나머지는 count와 truncated로만 */
const BULK_EVENT_SERIALS = 100;

/** merge 필드 → 컬럼 */
const COLUMN: Record<keyof ConnectivityRow, string> = {
  terminalId: 'terminal_id',
  online: 'online',
  lastSeenAt: 'last_seen_at',
  firmwareVersion: 'firmware_version',
  changedAt: 'changed_at',
};

/**
 * 이미 있는 행에서 덮어쓸 식. lastSeenAt은 GREATEST로 — 늦게 커밋된 스냅샷·판정이 들고 있던 더 오래된 값이
 * 더 새 값을 덮지 않게 한다(뒤로 가지 않음). firmwareVersion은 COALESCE로 — Redis firmware HASH에 값이 없어 null로 온 행이
 * 이미 아는 버전을 지우지 않게 한다(Task 6 리뷰). MySQL 8.4에서 VALUES()는 deprecated지만 동작한다(행 별칭 문법은 MikroORM이 만들지 않음).
 */
function mergeExpr(merge: (keyof ConnectivityRow)[]) {
  const expr = (f: keyof ConnectivityRow, c: string) => {
    if (f === 'lastSeenAt') return `greatest(${c}, values(${c}))`;
    if (f === 'firmwareVersion') return `coalesce(values(${c}), ${c})`;
    return `values(${c})`;
  };
  return Object.fromEntries(merge.map((f) => [f, raw(expr(f, `\`${COLUMN[f]}\``))]));
}

/**
 * device_connectivity UPSERT(`insert … on duplicate key update`). 행은 terminal_id 오름차순으로 넘긴다(여러 행 잠금 순서).
 * em.upsertMany를 쓰지 않는 이유: MikroORM 7.2.5는 MySQL에서 UPSERT 뒤에 관리 엔티티를 만들려고 같은 행을
 * `select … where terminal_id = ? or …`로 다시 읽는다(사전 검증, decisions/0029). 여기서는 엔티티가 필요 없어 QueryBuilder로 한 문장만 보낸다.
 * @param merge 이미 있는 행에서 덮어쓸 필드(lastSeenAt은 GREATEST로, mergeExpr)
 */
export async function upsertConnectivity(tx: EntityManager, rows: ConnectivityRow[], merge: (keyof ConnectivityRow)[]): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    await tx.createQueryBuilder(DeviceConnectivity).insert(rows.slice(i, i + UPSERT_CHUNK)).onConflict('terminalId').merge(mergeExpr(merge)).execute();
  }
}

/** [멤버, 점수, 멤버, 점수 …] → [[멤버, 점수]] */
function pairs(flat: string[]): [string, number][] {
  const out: [string, number][] = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], Number(flat[i + 1])]);
  return out;
}

/**
 * 접속 상태 판정과 스냅샷(F8, decisions/0029).
 * - detect: lastSeen이 기준(HEARTBEAT_OFFLINE_AFTER_MS)보다 오래된 운영 중 단말기를 오프라인으로, 오프라인으로 기록된 단말기 중
 *   하트비트가 다시 온 것을 온라인으로 바꾼다. **바뀐 것만** MySQL(device_connectivity UPSERT + Outbox 알림)에 쓴다.
 * - snapshot: 지난 스냅샷 뒤 lastSeen이 바뀐 단말기의 lastSeen·펌웨어를 MySQL에 한꺼번에 쓴다.
 * 둘 다 Redis 잠금으로 프로세스가 여럿이어도 한 번에 하나만 돈다. MySQL 쓰기는 terminal_id 오름차순(여러 행 잠금 순서).
 */
@Injectable()
export class ConnectivityService {
  private readonly logger = new Logger(ConnectivityService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly lock: RedisLock,
    private readonly em: EntityManager,
  ) {}

  async detect(now = Date.now(), offlineAfterMs = env.hbOfflineAfterMs): Promise<DetectResult> {
    const result = await this.exclusive('hb-detect', () => this.detectLocked(now, offlineAfterMs));
    return result ?? { offline: [], online: [], skipped: true };
  }

  async snapshot(): Promise<{ written: number; skipped?: boolean }> {
    const result = await this.exclusive('hb-snapshot', () => this.snapshotLocked());
    return result ?? { written: 0, skipped: true };
  }

  /** 접속 상태 조회: Redis(최신값)가 있으면 그것, 없으면 MySQL 스냅샷 */
  async get(serialNo: string, now = Date.now()): Promise<ConnectivityView> {
    const em = this.em.fork();
    const terminal = await em.findOne(Terminal, { serialNo });
    if (!terminal) throw new NotFoundException(`단말기 ${serialNo}이(가) 없습니다.`);
    const k = deviceKeys();
    const [score, firmware] = (await execOrThrow(this.redis.pipeline().zscore(k.lastSeen, serialNo).hget(k.firmware, serialNo))) as [
      string | null,
      string | null,
    ];
    if (score !== null) {
      const lastSeen = Number(score);
      return {
        serialNo,
        source: 'redis',
        online: lastSeen > now - env.hbOfflineAfterMs,
        lastSeenAt: new Date(lastSeen).toISOString(),
        firmwareVersion: firmware,
      };
    }
    const row = await em.findOne(DeviceConnectivity, { terminalId: terminal.id });
    if (row) {
      // 방어: 판정 job이 online을 못 내린 행(운영 이탈 직후 등)도 lastSeen이 기준보다 오래되면 오프라인으로 보인다
      const online = row.online && row.lastSeenAt.getTime() > now - env.hbOfflineAfterMs;
      return { serialNo, source: 'snapshot', online, lastSeenAt: row.lastSeenAt.toISOString(), firmwareVersion: row.firmwareVersion };
    }
    return { serialNo, source: 'none', online: false, lastSeenAt: null, firmwareVersion: null };
  }

  private async detectLocked(now: number, offlineAfterMs: number): Promise<DetectResult> {
    const k = deviceKeys();
    const cutoff = now - offlineAfterMs;
    const stale = pairs(await this.redis.zrangebyscore(k.lastSeen, '-inf', cutoff, 'WITHSCORES'));
    const recorded = await this.redis.smembers(k.offline);
    if (stale.length === 0 && recorded.length === 0) return { offline: [], online: [] };

    const look = this.redis.pipeline();
    if (stale.length > 0) {
      look.hmget(k.active, ...stale.map(([s]) => s));
      look.smismember(k.offline, ...stale.map(([s]) => s));
    }
    if (recorded.length > 0) {
      look.hmget(k.active, ...recorded);
      look.zmscore(k.lastSeen, ...recorded);
    }
    const all = [...new Set([...stale.map(([s]) => s), ...recorded])];
    look.hmget(k.firmware, ...all);
    const values = await execOrThrow(look);
    let at = 0;
    const [staleIds, staleRecorded] = stale.length > 0 ? [values[at++] as (string | null)[], values[at++] as number[]] : [[], []];
    const [recordedIds, recordedScores] =
      recorded.length > 0 ? [values[at++] as (string | null)[], values[at++] as (string | null)[]] : [[], []];
    const firmwareOf = new Map(all.map((s, i) => [s, (values[at] as (string | null)[])[i]]));

    type Change = { serialNo: string; terminalId: number; lastSeen: number; online: boolean };
    const changes: Change[] = [];
    const notActive: string[] = [];
    stale.forEach(([serialNo, lastSeen], i) => {
      if (staleIds[i] === null) notActive.push(serialNo);
      else if (!staleRecorded[i]) changes.push({ serialNo, terminalId: Number(staleIds[i]), lastSeen, online: false });
    });
    const dropped: string[] = [];
    recorded.forEach((serialNo, i) => {
      const score = recordedScores[i];
      if (recordedIds[i] === null) dropped.push(serialNo);
      else if (score !== null && Number(score) > cutoff) {
        changes.push({ serialNo, terminalId: Number(recordedIds[i]), lastSeen: Number(score), online: true });
      }
    });

    if (changes.length > 0 || notActive.length > 0) {
      changes.sort((a, b) => a.terminalId - b.terminalId);
      const changedAt = new Date(now);
      await this.em.fork().transactional(async (tx) => {
        // 운영에서 빠진 단말기: 알림 없이 online=false만(행이 online=true일 때). Redis 기록은 아래에서 지운다.
        // 이걸 안 하면 GET이 스냅샷 대체값으로 영영 online=true를 보였다.
        if (notActive.length > 0) await this.markOfflineSilently(tx, notActive, changedAt);
        if (changes.length === 0) return;
        await upsertConnectivity(
          tx,
          changes.map((c) => ({
            terminalId: c.terminalId,
            online: c.online,
            lastSeenAt: new Date(c.lastSeen),
            firmwareVersion: firmwareOf.get(c.serialNo) ?? null,
            changedAt,
          })),
          ['online', 'lastSeenAt', 'firmwareVersion', 'changedAt'],
        );
        // 방향(오프라인·온라인)마다 기준보다 많으면 묶음 한 행. 5,000행이면 relay(2초에 100행) 줄이 100초가 되어
        // 그 뒤의 terminal.status_changed 알림과 project job까지 밀렸다(실험 0010).
        for (const online of [false, true]) {
          const group = changes.filter((c) => c.online === online);
          if (group.length > env.connectivityBulkEventThreshold) {
            tx.create(OutboxEvent, {
              type: online ? OUTBOX_TYPE.DEVICE_ONLINE_BULK : OUTBOX_TYPE.DEVICE_OFFLINE_BULK,
              payload: {
                count: group.length,
                serials: group.slice(0, BULK_EVENT_SERIALS).map((c) => c.serialNo),
                truncated: group.length > BULK_EVENT_SERIALS,
                detectedAt: changedAt.toISOString(),
              },
            });
            continue;
          }
          for (const c of group) {
            tx.create(OutboxEvent, {
              type: online ? OUTBOX_TYPE.DEVICE_ONLINE : OUTBOX_TYPE.DEVICE_OFFLINE,
              payload: { serialNo: c.serialNo, lastSeenAt: new Date(c.lastSeen).toISOString(), detectedAt: changedAt.toISOString() },
            });
          }
        }
      });
    }

    // MySQL이 커밋된 뒤 Redis 기록을 맞춘다. 여기서 죽으면 다음 판정이 같은 변화를 다시 쓴다(알림 중복 가능, 최소 한 번).
    const offline = changes.filter((c) => !c.online).map((c) => c.serialNo);
    const online = changes.filter((c) => c.online).map((c) => c.serialNo);
    const after = this.redis.pipeline();
    if (offline.length > 0) after.sadd(k.offline, ...offline);
    if (online.length + dropped.length > 0) after.srem(k.offline, ...online, ...dropped);
    // 운영 중이 아닌 단말기의 오래된 기록은 알림 없이 지운다(회수·폐기된 단말기)
    if (notActive.length > 0) after.zrem(k.lastSeen, ...notActive).hdel(k.firmware, ...notActive);
    if (after.length > 0) await execOrThrow(after);
    if (changes.length > 0) this.logger.log(`접속 상태 변화: 오프라인 ${offline.length}, 온라인 ${online.length}`);
    return { offline, online };
  }

  private async snapshotLocked(): Promise<{ written: number }> {
    const k = deviceKeys();
    const from = Number((await this.redis.get(k.snapshotAt)) ?? 0);
    const changed = pairs(await this.redis.zrangebyscore(k.lastSeen, `(${from}`, '+inf', 'WITHSCORES'));
    if (changed.length === 0) return { written: 0 };
    const serials = changed.map(([s]) => s);
    const [ids, firmware] = (await execOrThrow(this.redis.pipeline().hmget(k.active, ...serials).hmget(k.firmware, ...serials))) as (
      | string
      | null
    )[][];
    const now = Date.now();
    const rows = changed
      .map(([, lastSeen], i) => ({ id: ids[i], lastSeen, firmware: firmware[i] }))
      .filter((r): r is { id: string; lastSeen: number; firmware: string | null } => r.id !== null)
      .map((r) => ({
        terminalId: Number(r.id),
        // 처음 쓰는 행만 이 값이 들어간다. 이미 있는 행의 online은 판정 job만 바꾼다(merge 대상에서 뺐다).
        online: r.lastSeen > now - env.hbOfflineAfterMs,
        lastSeenAt: new Date(r.lastSeen),
        firmwareVersion: r.firmware,
        changedAt: new Date(now),
      }))
      .sort((a, b) => a.terminalId - b.terminalId);
    if (rows.length > 0) {
      await this.em.fork().transactional((tx) => upsertConnectivity(tx, rows, ['lastSeenAt', 'firmwareVersion']));
    }
    // Math.max(...배열)은 인자 수 한도(수만~수십만)에서 RangeError가 날 수 있어 reduce로
    await this.redis.set(k.snapshotAt, String(changed.reduce((max, [, s]) => (s > max ? s : max), from)));
    return { written: rows.length };
  }

  /** 시리얼들의 device_connectivity 행 중 online=true인 것만 false로(알림 없음). terminal_id 오름차순 */
  private async markOfflineSilently(tx: EntityManager, serials: string[], changedAt: Date): Promise<void> {
    const ids: { id: number }[] = await tx
      .createQueryBuilder(Terminal)
      .select(['id'])
      .where({ serialNo: { $in: serials } })
      .orderBy({ id: 'asc' })
      .execute('all');
    if (ids.length === 0) return;
    await tx
      .createQueryBuilder(DeviceConnectivity)
      .update({ online: false, changedAt })
      .where({ terminalId: { $in: ids.map((r) => r.id) }, online: true })
      .execute();
  }

  /** Redis 잠금을 잡고 fn을 돌린다. 이미 누가 돌리고 있으면 null */
  private async exclusive<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    const key = this.lock.keyOf('job-lock', name);
    const token = await this.lock.acquire(key, JOB_LOCK_TTL_MS);
    if (!token) return null;
    try {
      return await fn();
    } finally {
      await this.lock.release(key, token).catch((error: unknown) => this.logger.warn(`잠금 해제 실패 ${name}: ${String(error)}`));
    }
  }
}
