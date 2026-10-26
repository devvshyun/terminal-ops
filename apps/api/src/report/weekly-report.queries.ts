import { Injectable } from '@nestjs/common';
import { EntityManager, IsolationLevel } from '@mikro-orm/mysql';
import { fromDbDatetime } from '../common/db-datetime.js';
import { env } from '../config/env.js';
import type { KstWeek } from './kst-week.js';

/** 이상 단말기 시트에 담는 최대 행 수(나머지는 total로만) */
export const ANOMALY_SHEET_LIMIT = 1000;

/**
 * 주간 리포트 데이터. 기준 시점이 두 가지다(decisions/0035):
 * - 현황(statusByModel, anomalies, connectivity)은 생성 시점(generatedAt) 기준 — 그 주 끝이 아니라 만든 순간의 모습이다.
 * - 전이(transitions)·입출고(flows)·배포(rollouts)는 그 주 [from, to) 기준. 단 배포의 targets·succeeded·failed·timedOut은
 *   그 주에 생긴 것만이 아니라 배포마다 누적(만든 시점까지)이다. van은 만든 시점까지 가장 최근에 끝난 대조.
 */
export interface WeeklyReportData {
  week: { weekStart: string; from: string; to: string };
  generatedAt: string;
  /** 모델·상태별 단말기 수(만든 시각 기준) */
  statusByModel: { modelCode: string; status: string; count: number }[];
  /** 그 주의 전이 수(출처·도착 상태별) */
  transitions: { source: string; toStatus: string; count: number }[];
  /** 그 주의 입고(신규 등록)·출고·회수 입고 수(모델별) */
  flows: { modelCode: string; received: number; shipped: number; returned: number }[];
  /** 열린 이상 단말기(만든 시각 기준) */
  anomalies: {
    total: number;
    byRule: { rule: string; open: number }[];
    items: { serialNo: string; status: string; rule: string; detectedAt: string; lastSeenAt: string }[];
  };
  /** 운영 중 단말기의 접속 상태(MySQL 기준: 판정 job이 맞추는 online, 스냅샷 last_seen_at은 넓힌 창의 방어로만) */
  connectivity: { inService: number; online: number; offline: number; noRecord: number };
  /** 그 주에 진행 중이었거나 끝난 펌웨어 배포. 대상·성공·실패·시간 초과 수는 배포마다 누적(그 주 증분 아님) */
  rollouts: {
    id: number;
    modelCode: string;
    version: string;
    status: string;
    createdAt: string;
    finishedAt: string | null;
    endReason: string | null;
    targets: number;
    succeeded: number;
    failed: number;
    timedOut: number;
  }[];
  /** 가장 최근에 끝난 VAN 대조. unverifiable·acknowledgeDrop은 계획 뒤 fix 커밋이 넣은 열(확인 불가 수, 급감 확인 후 실행) */
  van: {
    runId: number;
    finishedAt: string;
    fetched: number;
    candidates: number;
    confirmed: number;
    resolved: number;
    unverifiable: number;
    acknowledgeDrop: boolean;
    counts: Record<string, number>;
  } | null;
}

/**
 * 리포트가 online=1 행을 온라인으로 세는 마지막 하트비트 창(ms) = 오프라인 기준 + 스냅샷 주기(기본 90s + 60s = 150s).
 * 리포트는 Redis가 아니라 MySQL 스냅샷만 보므로 조회 API의 기준(HEARTBEAT_OFFLINE_AFTER_MS)을 그대로 쓰면 정상 단말기가 경계에서 오프라인이 된다.
 */
export const reportOnlineWindowMs = () => env.hbOfflineAfterMs + env.connectivitySnapshotIntervalMs;

const n = (v: unknown) => Number(v ?? 0);

/**
 * 주 입력 검사(리뷰 반영). NaN 시각이 파라미터로 가면 mysql2가 'Invalid date'를 보내 MySQL이 엉뚱하게 비교하거나
 * toISOString()이 RangeError로 엉뚱한 자리에서 터진다 — DB에 가기 전에 이유를 담아 던진다.
 */
function assertValidWeek(week: KstWeek): void {
  const bad = (why: string) => new Error(`주간 리포트 주 ${week.weekStart}: ${why}`);
  if (!(week.from instanceof Date) || Number.isNaN(week.from.getTime())) throw bad(`from이 올바른 시각이 아닙니다(${String(week.from)})`);
  if (!(week.to instanceof Date) || Number.isNaN(week.to.getTime())) throw bad(`to가 올바른 시각이 아닙니다(${String(week.to)})`);
  if (week.to.getTime() <= week.from.getTime()) throw bad(`to(${week.to.toISOString()})가 from(${week.from.toISOString()})보다 늦어야 합니다`);
}
const iso = (v: string | Date) => fromDbDatetime(v).toISOString();

/**
 * 주간 운영 리포트 데이터(F11). 모든 집계는 DB에서 한다(행을 앱으로 가져와 세지 않는다). 이상 단말기 목록만 최대 1,000행을 가져온다.
 * 일곱 쿼리를 한 REPEATABLE READ 읽기 전용 트랜잭션에서 돌려 같은 시점을 본다(F10 대조와 같은 방식).
 * 주 경계는 UTC 시각 [from, to)로 넘긴다 — SQL의 NOW()·세션 시간대를 쓰지 않는다(troubleshooting/0016).
 */
@Injectable()
export class WeeklyReportQueries {
  constructor(private readonly em: EntityManager) {}

  async collect(week: KstWeek, now = new Date()): Promise<WeeklyReportData> {
    assertValidWeek(week);
    return this.em.fork().transactional(
      async (tx) => {
        const range = [week.from, week.to];
        const statusByModel = await tx.execute<{ model_code: string; status: string; c: unknown }[]>(
          `select m.code as model_code, t.status, count(*) as c
             from terminal t join terminal_model m on m.id = t.model_id
            group by m.code, t.status order by m.code, t.status`,
        );
        const transitions = await tx.execute<{ source: string; to_status: string; c: unknown }[]>(
          `select source, to_status, count(*) as c from terminal_status_history
            where occurred_at >= ? and occurred_at < ?
            group by source, to_status order by source, to_status`,
          range,
        );
        const flows = await tx.execute<{ model_code: string; received: unknown; shipped: unknown; returned: unknown }[]>(
          `select m.code as model_code,
                  sum(h.to_status = 'RECEIVED' and h.from_status is null) as received,
                  sum(h.to_status = 'SHIPPED') as shipped,
                  sum(h.to_status = 'RETURNED') as returned
             from terminal_status_history h
             join terminal t on t.id = h.terminal_id
             join terminal_model m on m.id = t.model_id
            where h.occurred_at >= ? and h.occurred_at < ? and h.to_status in ('RECEIVED', 'SHIPPED', 'RETURNED')
            group by m.code order by m.code`,
          range,
        );
        const byRule = await tx.execute<{ rule: string; c: unknown }[]>(
          'select rule, count(*) as c from anomaly where resolved_at is null group by rule order by rule',
        );
        const anomalyItems = await tx.execute<{ serial_no: string; status: string; rule: string; detected_at: string; last_seen_at: string }[]>(
          `select t.serial_no, t.status, a.rule, a.detected_at, a.last_seen_at
             from anomaly a join terminal t on t.id = a.terminal_id
            where a.resolved_at is null
            order by a.rule, a.detected_at, a.id limit ${ANOMALY_SHEET_LIMIT}`,
        );
        // 온라인 = 판정 job(Redis 기준, OFFLINE_DETECT_INTERVAL_MS마다)이 맞추는 online=1(최종 리뷰 반영, decisions/0035).
        // last_seen_at은 스냅샷 job이 CONNECTIVITY_SNAPSHOT_INTERVAL_MS마다 쓴 값이라 정상 단말기도 하트비트 주기 + 스냅샷 주기만큼 낡는다.
        // 그래서 시각 조건은 "판정 job이 멈춰 online=1이 남은 행"을 거르는 방어로만 두고 창을 오프라인 기준 + 스냅샷 주기로 넓힌다
        // (부등호는 조회 API와 같은 lastSeen > now − 창, 정확히 창만큼 지났으면 오프라인).
        const [conn] = await tx.execute<{ in_service: unknown; online: unknown; no_record: unknown }[]>(
          `select count(*) as in_service,
                  sum(c.online = 1 and c.last_seen_at > ?) as online,
                  sum(c.terminal_id is null) as no_record
             from terminal t left join device_connectivity c on c.terminal_id = t.id
            where t.status = 'IN_SERVICE'`,
          [new Date(now.getTime() - reportOnlineWindowMs())],
        );
        const rollouts = await tx.execute<
          {
            id: number;
            model_code: string;
            version: string;
            status: string;
            created_at: string;
            finished_at: string | null;
            end_reason: string | null;
            targets: unknown;
            succeeded: unknown;
            failed: unknown;
            timed_out: unknown;
          }[]
        >(
          `select r.id, m.code as model_code, f.version, r.status, r.created_at, r.finished_at, r.end_reason,
                  count(x.id) as targets,
                  sum(x.status = 'SUCCEEDED') as succeeded, sum(x.status = 'FAILED') as failed, sum(x.status = 'TIMED_OUT') as timed_out
             from firmware_rollout r
             join firmware f on f.id = r.firmware_id
             join terminal_model m on m.id = f.model_id
             left join firmware_rollout_target x on x.rollout_id = r.id
            where r.created_at < ? and (r.finished_at is null or r.finished_at >= ?)
            group by r.id, m.code, f.version, r.status, r.created_at, r.finished_at, r.end_reason
            order by r.id`,
          [week.to, week.from],
        );
        const [van] = await tx.execute<
          {
            id: number;
            finished_at: string;
            fetched: number;
            candidates: number;
            confirmed: number;
            resolved: number;
            unverifiable: number;
            acknowledge_drop: unknown;
            counts: Record<string, number> | string | null;
          }[]
        >(
          `select id, finished_at, fetched, candidates, confirmed, resolved, unverifiable, acknowledge_drop, counts
             from van_reconciliation_run where status = 'COMPLETED' order by id desc limit 1`,
        );

        const inService = n(conn.in_service);
        const online = n(conn.online);
        const noRecord = n(conn.no_record);
        return {
          week: { weekStart: week.weekStart, from: week.from.toISOString(), to: week.to.toISOString() },
          generatedAt: now.toISOString(),
          statusByModel: statusByModel.map((r) => ({ modelCode: r.model_code, status: r.status, count: n(r.c) })),
          transitions: transitions.map((r) => ({ source: r.source, toStatus: r.to_status, count: n(r.c) })),
          flows: flows.map((r) => ({ modelCode: r.model_code, received: n(r.received), shipped: n(r.shipped), returned: n(r.returned) })),
          anomalies: {
            total: byRule.reduce((sum, r) => sum + n(r.c), 0),
            byRule: byRule.map((r) => ({ rule: r.rule, open: n(r.c) })),
            items: anomalyItems.map((r) => ({ serialNo: r.serial_no, status: r.status, rule: r.rule, detectedAt: iso(r.detected_at), lastSeenAt: iso(r.last_seen_at) })),
          },
          connectivity: { inService, online, offline: inService - online - noRecord, noRecord },
          rollouts: rollouts.map((r) => ({
            id: r.id,
            modelCode: r.model_code,
            version: r.version,
            status: r.status,
            createdAt: iso(r.created_at),
            finishedAt: r.finished_at ? iso(r.finished_at) : null,
            endReason: r.end_reason,
            targets: n(r.targets),
            succeeded: n(r.succeeded),
            failed: n(r.failed),
            timedOut: n(r.timed_out),
          })),
          van: van
            ? {
                runId: van.id,
                finishedAt: iso(van.finished_at),
                fetched: van.fetched,
                candidates: van.candidates,
                confirmed: van.confirmed,
                resolved: van.resolved,
                unverifiable: van.unverifiable,
                acknowledgeDrop: n(van.acknowledge_drop) === 1,
                counts: typeof van.counts === 'string' ? JSON.parse(van.counts) : (van.counts ?? {}),
              }
            : null,
        };
      },
      { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
    );
  }
}
