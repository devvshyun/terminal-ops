import { Injectable } from '@nestjs/common';
import { EntityManager, IsolationLevel } from '@mikro-orm/mysql';
import { ANOMALY_RULE_LABEL } from '../anomaly/anomaly-labels.js';
import type { AnomalyRule } from '../anomaly/anomaly.entity.js';
import { fromDbDatetime } from '../common/db-datetime.js';
import { kstWeekOf } from '../report/kst-week.js';
import { reportOnlineWindowMs } from '../report/weekly-report.queries.js';
import { TerminalStatus } from '../terminal/terminal-status.js';

/** 어드민 처음 화면의 숫자 묶음(decisions/0044). 모두 집계 시각(now) 기준 */
export interface DashboardSummary {
  terminals: {
    total: number;
    /** 상태 순서(전이 표의 enum 순서), 0대인 상태는 빠진다 */
    byStatus: { status: string; count: number }[];
    byModel: { modelCode: string; count: number }[];
  };
  /** 운영 중 단말기의 접속 상태(주간 리포트와 같은 MySQL 기준 — 판정 job이 맞추는 online, 창 = 오프라인 기준 + 스냅샷 주기) */
  connectivity: { inService: number; online: number; offline: number; noRecord: number };
  /** 열린 이상(규칙 순서, 0인 규칙은 빠진다) */
  anomalies: { open: number; byRule: { rule: string; label: string; open: number }[] };
  /** 끝나지 않은 펌웨어 배포(RUNNING·PAUSED) */
  rollouts: { active: number };
  /** 열린 A/S(OPEN·REPLACING) */
  serviceTickets: { open: number };
  /** 가장 최근에 끝난(COMPLETED) VAN 대조 */
  van: { runId: number; finishedAt: string; confirmed: number; counts: Record<string, number> } | null;
  /** 이번 주(KST 월요일 00:00부터 집계 시각까지) 상태 전이 수 */
  week: { weekStart: string; transitions: number };
}

const n = (v: unknown) => Number(v ?? 0);

/**
 * 대시보드 집계(F11 어드민 처음 화면). 모두 DB에서 센다. 한 REPEATABLE READ 읽기 전용 트랜잭션에서 같은 시점을 본다
 * (주간 리포트 집계와 같은 방식, decisions/0035). 쿼리 일곱 개 — 가장 비싼 것은 이번 주 전이 수로, 이력 표에 occurred_at
 * 인덱스가 없어(decisions/0036) 이력 전체를 훑는다. 그래서 결과를 Redis에 짧게 캐시한다(DashboardService, decisions/0044).
 */
@Injectable()
export class DashboardQueries {
  constructor(private readonly em: EntityManager) {}

  async collect(now = new Date()): Promise<DashboardSummary> {
    const week = kstWeekOf(now);
    return this.em.fork().transactional(
      async (tx) => {
        const statusByModel = await tx.execute<{ model_code: string; status: string; c: unknown }[]>(
          `select m.code as model_code, t.status, count(*) as c
             from terminal t join terminal_model m on m.id = t.model_id
            group by m.code, t.status order by m.code, t.status`,
        );
        const [conn] = await tx.execute<{ in_service: unknown; online: unknown; no_record: unknown }[]>(
          `select count(*) as in_service,
                  sum(c.online = 1 and c.last_seen_at > ?) as online,
                  sum(c.terminal_id is null) as no_record
             from terminal t left join device_connectivity c on c.terminal_id = t.id
            where t.status = 'IN_SERVICE'`,
          [new Date(now.getTime() - reportOnlineWindowMs())],
        );
        const byRule = await tx.execute<{ rule: AnomalyRule; c: unknown }[]>(
          'select rule, count(*) as c from anomaly where resolved_at is null group by rule',
        );
        const [rollouts] = await tx.execute<{ c: unknown }[]>("select count(*) as c from firmware_rollout where status in ('RUNNING', 'PAUSED')");
        const [tickets] = await tx.execute<{ c: unknown }[]>("select count(*) as c from service_ticket where status in ('OPEN', 'REPLACING')");
        const [van] = await tx.execute<{ id: number; finished_at: string; confirmed: number; counts: Record<string, number> | string | null }[]>(
          "select id, finished_at, confirmed, counts from van_reconciliation_run where status = 'COMPLETED' order by id desc limit 1",
        );
        const [transitions] = await tx.execute<{ c: unknown }[]>(
          'select count(*) as c from terminal_status_history where occurred_at >= ? and occurred_at < ?',
          [week.from, now],
        );

        const byStatus = new Map<string, number>();
        const byModel = new Map<string, number>();
        for (const r of statusByModel) {
          byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + n(r.c));
          byModel.set(r.model_code, (byModel.get(r.model_code) ?? 0) + n(r.c));
        }
        const openByRule = new Map(byRule.map((r) => [r.rule, n(r.c)]));
        const inService = n(conn.in_service);
        const online = n(conn.online);
        const noRecord = n(conn.no_record);
        return {
          terminals: {
            total: [...byStatus.values()].reduce((a, b) => a + b, 0),
            byStatus: Object.values(TerminalStatus)
              .filter((status) => byStatus.has(status))
              .map((status) => ({ status, count: byStatus.get(status)! })),
            byModel: [...byModel].map(([modelCode, count]) => ({ modelCode, count })),
          },
          connectivity: { inService, online, offline: inService - online - noRecord, noRecord },
          anomalies: {
            open: [...openByRule.values()].reduce((a, b) => a + b, 0),
            byRule: (Object.keys(ANOMALY_RULE_LABEL) as AnomalyRule[])
              .filter((rule) => (openByRule.get(rule) ?? 0) > 0)
              .map((rule) => ({ rule, label: ANOMALY_RULE_LABEL[rule], open: openByRule.get(rule)! })),
          },
          rollouts: { active: n(rollouts.c) },
          serviceTickets: { open: n(tickets.c) },
          van: van
            ? {
                runId: van.id,
                finishedAt: fromDbDatetime(van.finished_at).toISOString(),
                confirmed: van.confirmed,
                counts: typeof van.counts === 'string' ? JSON.parse(van.counts) : (van.counts ?? {}),
              }
            : null,
          week: { weekStart: week.weekStart, transitions: n(transitions.c) },
        };
      },
      { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
    );
  }
}
