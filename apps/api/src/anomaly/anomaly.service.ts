import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import { BusinessError } from '../common/domain-errors.js';
import { env } from '../config/env.js';
import { OUTBOX_TYPE, OutboxEvent } from '../outbox/outbox-event.entity.js';
import { RedisLock } from '../redis/redis-lock.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { Anomaly, AnomalyRule } from './anomaly.entity.js';
import { findAnomalies, type AnomalyMatch, type AnomalyThresholds } from './anomaly-rules.js';

/**
 * 찾기 잠금 유지 시간. 찾기 한 번이 이보다 길면 다른 찾기가 겹칠 수 있다 — 겹쳐도 INSERT가 ON DUPLICATE KEY UPDATE라
 * 500이 아니고 열린 이상은 (단말기, 규칙)마다 하나로 남는다(fix, decisions/0034)
 */
const SCAN_LOCK_TTL_MS = 5 * 60_000;

/** PK IN (…) 갱신·INSERT 한 문장의 행 수 */
const CHUNK = 500;

/** 묶음 알림 payload에 담는 시리얼 수. 나머지는 count와 truncated로만 */
const BULK_EVENT_SERIALS = 100;

export interface ScanResult {
  /** 새로 걸린 이상 */
  detected: number;
  /** 계속 걸려 있는 이상(last_seen_at 갱신) */
  continuing: number;
  /** 조건이 풀려 닫은 이상 */
  resolved: number;
  /** 찾기가 끝난 뒤 열린 이상 수(규칙별) */
  open: Partial<Record<AnomalyRule, number>>;
  /** 새로 걸린 이상(알림용) */
  newMatches: AnomalyMatch[];
}

/**
 * 열린 이상 PK `IN (…)` 갱신 문장. `resolved_at is null`은 겹친 찾기가 이미 닫은 행을 다시 건드리지 않으려고 둔다(빼면 안전하지 않다).
 * 그 조건이 있으면 옵티마이저가 (resolved_at, rule) 보조 인덱스 범위를 고를 수 있어(EXPLAIN UPDATE로 확인, decisions/0034)
 * `force index (primary)`로 PK 범위만 잠그게 한다(troubleshooting/0014).
 */
export function openRowsUpdateSql(column: 'last_seen_at' | 'resolved_at', count: number): string {
  return `update \`anomaly\` force index (primary) set \`${column}\` = ? where \`id\` in (${Array.from({ length: count }, () => '?').join(', ')}) and \`resolved_at\` is null`;
}

const keyOf = (m: { terminalId: number; rule: AnomalyRule }) => `${m.terminalId}:${m.rule}`;

/**
 * 이상 단말기 찾기(F4, decisions/0034). 규칙 SQL로 지금 걸린 단말기를 모두 구하고 열린 이상과 비교해
 * ① 새로 걸린 것 INSERT ② 계속 걸린 것 last_seen_at ③ 풀린 것 resolved_at — 셋 다 한 트랜잭션, 갱신은 PK `IN (…)`
 * (보조 인덱스 범위 UPDATE의 gap 락을 피함, troubleshooting/0014). Redis 잠금으로 한 번에 하나만 돈다.
 * 잠금이 만료돼 두 찾기가 겹치면: 늦게 쓰는 쪽의 INSERT는 열린 이상 unique에 걸려 last_seen_at만 바꾸고(ON DUPLICATE KEY UPDATE),
 * PK 갱신은 `resolved_at is null` 조건이라 앞 찾기가 닫은 행을 다시 건드리지 않는다. "새로 걸림"은 이 찾기가 실제로 넣은 행만 센다.
 */
@Injectable()
export class AnomalyService {
  private readonly logger = new Logger(AnomalyService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly lock: RedisLock,
  ) {}

  /** 찾기 한 번. 다른 찾기가 돌고 있으면 409 ANOMALY_SCAN_RUNNING */
  async scan(now = new Date(), thresholds?: AnomalyThresholds): Promise<ScanResult> {
    const key = this.lock.keyOf('job-lock', 'anomaly-scan');
    const token = await this.lock.acquire(key, SCAN_LOCK_TTL_MS);
    if (!token) throw new BusinessError(409, 'ANOMALY_SCAN_RUNNING', '이상 단말기 찾기가 이미 돌고 있습니다.');
    try {
      return await this.scanLocked(now, thresholds);
    } finally {
      await this.lock.release(key, token).catch((error: unknown) => this.logger.warn(`잠금 해제 실패 anomaly-scan: ${String(error)}`));
    }
  }

  private async scanLocked(now: Date, thresholds?: AnomalyThresholds): Promise<ScanResult> {
    const em = this.em.fork();
    const matches = await findAnomalies(em, now, thresholds);
    const open = await em.find(Anomaly, { resolvedAt: null }, { fields: ['id', 'terminalId', 'rule'], orderBy: { id: 'asc' } });
    const openByKey = new Map(open.map((a) => [keyOf(a), a.id]));
    const matchKeys = new Set(matches.map(keyOf));
    const newMatches = matches.filter((m) => !openByKey.has(keyOf(m)));
    const continuing = open.filter((a) => matchKeys.has(keyOf(a))).map((a) => a.id);
    const resolved = open.filter((a) => !matchKeys.has(keyOf(a))).map((a) => a.id);

    let inserted = newMatches;
    await em.transactional(async (tx) => {
      for (let i = 0; i < newMatches.length; i += CHUNK) {
        // 겹친 찾기가 그사이 같은 (단말기, 규칙)을 열었으면 열린 이상 unique(함수 인덱스)에 걸려 last_seen_at만 갱신한다
        await tx
          .createQueryBuilder(Anomaly)
          .insert(newMatches.slice(i, i + CHUNK).map((m) => ({ terminalId: m.terminalId, rule: m.rule, detectedAt: now, lastSeenAt: now, resolvedAt: null, detail: m.detail })))
          .onConflict()
          .merge(['lastSeenAt'])
          .execute();
      }
      if (newMatches.length > 0) {
        // 실제로 이 찾기가 넣은 행 = 열린 이상 중 detected_at이 이 찾기 시각인 것. 나머지는 겹친 찾기가 먼저 연 것(계속으로 센다)
        const mine = await tx.find(Anomaly, { resolvedAt: null, detectedAt: now }, { fields: ['terminalId', 'rule'] });
        const mineKeys = new Set(mine.map(keyOf));
        inserted = newMatches.filter((m) => mineKeys.has(keyOf(m)));
      }
      for (let i = 0; i < continuing.length; i += CHUNK) {
        const ids = continuing.slice(i, i + CHUNK);
        await tx.execute(openRowsUpdateSql('last_seen_at', ids.length), [now, ...ids]);
      }
      for (let i = 0; i < resolved.length; i += CHUNK) {
        const ids = resolved.slice(i, i + CHUNK);
        await tx.execute(openRowsUpdateSql('resolved_at', ids.length), [now, ...ids]);
      }
      // 알림은 이 찾기가 실제로 넣은 행만(겹친 찾기가 먼저 연 것은 그 찾기가 알렸다)
      this.recordNotifications(tx, inserted, now);
    });

    const openNow: Partial<Record<AnomalyRule, number>> = {};
    for (const m of matches) openNow[m.rule] = (openNow[m.rule] ?? 0) + 1;
    const merged = newMatches.length - inserted.length;
    if (merged > 0) this.logger.warn(`이상 단말기 찾기가 겹침: ${merged}건은 다른 찾기가 먼저 열어 last_seen_at만 갱신`);
    if (inserted.length + resolved.length > 0) {
      this.logger.log(`이상 단말기 찾기: 새로 ${inserted.length}, 계속 ${continuing.length + merged}, 풀림 ${resolved.length}`);
    }
    return { detected: inserted.length, continuing: continuing.length + merged, resolved: resolved.length, open: openNow, newMatches: inserted };
  }

  /**
   * 새로 걸린 이상의 알림을 같은 트랜잭션의 Outbox에 남긴다(유실 없음, decisions/0016). 기준(ANOMALY_BULK_EVENT_THRESHOLD)보다 많으면
   * 규칙별 수를 담은 묶음 한 행 — 첫 찾기나 큰 장애 뒤에 수천 행이 relay 줄을 막지 않게(experiments/0010, Day 4 방식).
   * 계속 걸린 이상과 풀린 이상은 알리지 않는다(매일 같은 알림이 반복되지 않게. 열린 이상은 주간 리포트에 나온다).
   */
  private recordNotifications(tx: EntityManager, newMatches: AnomalyMatch[], now: Date): void {
    if (newMatches.length === 0) return;
    if (newMatches.length > env.anomalyBulkEventThreshold) {
      const byRule: Partial<Record<AnomalyRule, number>> = {};
      for (const m of newMatches) byRule[m.rule] = (byRule[m.rule] ?? 0) + 1;
      tx.create(OutboxEvent, {
        type: OUTBOX_TYPE.ANOMALY_DETECTED_BULK,
        payload: {
          count: newMatches.length,
          byRule,
          serials: newMatches.slice(0, BULK_EVENT_SERIALS).map((m) => m.serialNo),
          truncated: newMatches.length > BULK_EVENT_SERIALS,
          detectedAt: now.toISOString(),
        },
      });
      return;
    }
    for (const m of newMatches) {
      tx.create(OutboxEvent, {
        type: OUTBOX_TYPE.ANOMALY_DETECTED,
        payload: { serialNo: m.serialNo, rule: m.rule, ...(typeof m.detail.days === 'number' ? { days: m.detail.days } : {}), detectedAt: now.toISOString() },
      });
    }
  }

  /** 이상 목록 한 페이지(id 순, afterId 뒤부터). 단말기 시리얼·지금 상태를 붙인다 */
  async list(q: { rule?: AnomalyRule; open?: boolean; afterId?: number; limit: number }) {
    const em = this.em.fork();
    const rows = await em.find(
      Anomaly,
      {
        id: { $gt: q.afterId ?? 0 },
        ...(q.rule ? { rule: q.rule } : {}),
        ...(q.open === undefined ? {} : q.open ? { resolvedAt: null } : { resolvedAt: { $ne: null } }),
      },
      { orderBy: { id: 'asc' }, limit: q.limit + 1 },
    );
    const page = rows.slice(0, q.limit);
    const terminals = new Map(
      (await em.find(Terminal, { id: { $in: [...new Set(page.map((a) => a.terminalId))] } }, { fields: ['id', 'serialNo', 'status'] })).map((t) => [t.id, t]),
    );
    return {
      items: page.map((a) => ({
        id: a.id,
        serialNo: terminals.get(a.terminalId)?.serialNo ?? null,
        status: terminals.get(a.terminalId)?.status ?? null,
        rule: a.rule,
        detectedAt: a.detectedAt.toISOString(),
        lastSeenAt: a.lastSeenAt.toISOString(),
        resolvedAt: a.resolvedAt?.toISOString() ?? null,
        detail: a.detail,
      })),
      nextAfterId: rows.length > q.limit ? page.at(-1)!.id : null,
    };
  }
}
