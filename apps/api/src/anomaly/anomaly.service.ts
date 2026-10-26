import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import { BusinessError } from '../common/domain-errors.js';
import { RedisLock } from '../redis/redis-lock.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { Anomaly, AnomalyRule } from './anomaly.entity.js';
import { findAnomalies, type AnomalyMatch, type AnomalyThresholds } from './anomaly-rules.js';

/** 찾기 잠금 유지 시간. 찾기 한 번이 이보다 길면 다른 찾기가 겹칠 수 있다(겹쳐도 열린 이상 unique가 막는다) */
const SCAN_LOCK_TTL_MS = 5 * 60_000;

/** PK IN (…) 갱신·INSERT 한 문장의 행 수 */
const CHUNK = 500;

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

const keyOf = (m: { terminalId: number; rule: AnomalyRule }) => `${m.terminalId}:${m.rule}`;

/**
 * 이상 단말기 찾기(F4, decisions/0034). 규칙 SQL로 지금 걸린 단말기를 모두 구하고 열린 이상과 비교해
 * ① 새로 걸린 것 INSERT ② 계속 걸린 것 last_seen_at ③ 풀린 것 resolved_at — 셋 다 한 트랜잭션, 갱신은 PK `IN (…)`
 * (보조 인덱스 범위 UPDATE의 gap 락을 피함, troubleshooting/0014). Redis 잠금으로 한 번에 하나만 돈다.
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

    await em.transactional(async (tx) => {
      for (let i = 0; i < newMatches.length; i += CHUNK) {
        await tx.insertMany(
          Anomaly,
          newMatches.slice(i, i + CHUNK).map((m) => ({ terminalId: m.terminalId, rule: m.rule, detectedAt: now, lastSeenAt: now, resolvedAt: null, detail: m.detail })),
        );
      }
      for (let i = 0; i < continuing.length; i += CHUNK) {
        await tx.nativeUpdate(Anomaly, { id: { $in: continuing.slice(i, i + CHUNK) }, resolvedAt: null }, { lastSeenAt: now });
      }
      for (let i = 0; i < resolved.length; i += CHUNK) {
        await tx.nativeUpdate(Anomaly, { id: { $in: resolved.slice(i, i + CHUNK) }, resolvedAt: null }, { resolvedAt: now });
      }
    });

    const openNow: Partial<Record<AnomalyRule, number>> = {};
    for (const m of matches) openNow[m.rule] = (openNow[m.rule] ?? 0) + 1;
    if (newMatches.length + resolved.length > 0) {
      this.logger.log(`이상 단말기 찾기: 새로 ${newMatches.length}, 계속 ${continuing.length}, 풀림 ${resolved.length}`);
    }
    return { detected: newMatches.length, continuing: continuing.length, resolved: resolved.length, open: openNow, newMatches };
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
