import type { EntityManager } from '@mikro-orm/mysql';
import { fromDbDatetime } from '../common/db-datetime.js';
import { env } from '../config/env.js';
import { DAY_MS } from '../config/env-number.js';
import { TerminalStatus as S } from '../terminal/terminal-status.js';
import { AnomalyRule } from './anomaly.entity.js';

/** 규칙별 기준일 */
export type AnomalyThresholds = typeof env.anomalyDays;

/** 규칙에 걸린 단말기 한 대 */
export interface AnomalyMatch {
  terminalId: number;
  serialNo: string;
  rule: AnomalyRule;
  detail: Record<string, unknown>;
}

/** "어떤 상태로 N일 넘게 있음" 규칙: 규칙 → (상태들, 기준일) */
function ageRules(d: AnomalyThresholds): { rule: AnomalyRule; statuses: S[]; days: number }[] {
  return [
    { rule: AnomalyRule.DELIVERED_NOT_INSTALLED, statuses: [S.DELIVERED], days: d.deliveredNotInstalled },
    { rule: AnomalyRule.RETURN_STALLED, statuses: [S.RETURN_REQUESTED, S.RETURNING], days: d.returnStalled },
    { rule: AnomalyRule.SHIPPED_TOO_LONG, statuses: [S.SHIPPED], days: d.shippedTooLong },
    // 배정 → 출고는 출고 API만 하고(SHIPMENT 출처), 출고하면 SHIPPED가 된다. 그래서 ALLOCATED로 N일 = "배정 뒤 출고 없음"
    { rule: AnomalyRule.ALLOCATED_NO_SHIPMENT, statuses: [S.ALLOCATED], days: d.allocatedNoShipment },
  ];
}

/**
 * 지금 규칙에 걸린 단말기를 모두 찾는다(F4, decisions/0034). 규칙마다 SQL 한 문장, 기준 시각은 앱에서 계산해 넘긴다
 * (SQL의 NOW()는 세션 시간대(SYSTEM=KST)라 UTC로 저장한 값과 비교하면 9시간 어긋난다, troubleshooting/0016).
 * - 상태 경과 규칙: `terminal (status, status_changed_at)` 인덱스 범위 하나(상태가 여럿이면 범위 여럿)
 * - 가맹점 없음: 같은 인덱스의 status 앞부분 + merchant_id 확인
 * - 오프라인: device_connectivity(offline이고 마지막 하트비트가 기준보다 전) ⟶ terminal PK, 운영 중만
 * 결과는 (terminalId, rule) 순서.
 */
export async function findAnomalies(em: EntityManager, now: Date, d: AnomalyThresholds = env.anomalyDays): Promise<AnomalyMatch[]> {
  const out: AnomalyMatch[] = [];
  const days = (since: Date) => Math.floor((now.getTime() - since.getTime()) / DAY_MS);
  for (const r of ageRules(d)) {
    const cutoff = new Date(now.getTime() - r.days * DAY_MS);
    const rows = await em.execute<{ id: number; serial_no: string; status: S; status_changed_at: string }[]>(
      `select id, serial_no, status, status_changed_at from terminal
        where status in (${r.statuses.map(() => '?').join(', ')}) and status_changed_at < ?`,
      [...r.statuses, cutoff],
    );
    for (const row of rows) {
      const since = fromDbDatetime(row.status_changed_at);
      out.push({ terminalId: row.id, serialNo: row.serial_no, rule: r.rule, detail: { status: row.status, since: since.toISOString(), days: days(since) } });
    }
  }
  const noMerchant = await em.execute<{ id: number; serial_no: string; status_changed_at: string }[]>(
    `select id, serial_no, status_changed_at from terminal where status = 'IN_SERVICE' and merchant_id is null`,
  );
  for (const row of noMerchant) {
    out.push({
      terminalId: row.id,
      serialNo: row.serial_no,
      rule: AnomalyRule.IN_SERVICE_NO_MERCHANT,
      detail: { status: S.IN_SERVICE, since: fromDbDatetime(row.status_changed_at).toISOString() },
    });
  }
  const offline = await em.execute<{ id: number; serial_no: string; last_seen_at: string }[]>(
    `select t.id, t.serial_no, c.last_seen_at
       from device_connectivity c join terminal t on t.id = c.terminal_id
      where c.online = 0 and c.last_seen_at < ? and t.status = 'IN_SERVICE'`,
    [new Date(now.getTime() - d.offlineTooLong * DAY_MS)],
  );
  for (const row of offline) {
    const lastSeen = fromDbDatetime(row.last_seen_at);
    out.push({ terminalId: row.id, serialNo: row.serial_no, rule: AnomalyRule.OFFLINE_TOO_LONG, detail: { lastSeenAt: lastSeen.toISOString(), days: days(lastSeen) } });
  }
  return out.sort((a, b) => a.terminalId - b.terminalId || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}
