import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { OpsErrorView } from '@terminal-ops/contracts';
import { OutboxEvent, OutboxStatus } from '../outbox/outbox-event.entity.js';
import { WeeklyReport } from '../report/weekly-report.entity.js';
import { SyncRun } from '../shipment/shipment.entities.js';
import { VanReconciliationRun, VanRunStatus } from '../van/van.entities.js';

/** 수집 기록은 최근 이만큼의 행(id) 안에서만 오류를 찾는다 — outcome에 인덱스가 없어 PK 범위로 읽는 양을 묶는다(decisions/0070) */
export const SYNC_RUN_SCAN_WINDOW = 10_000;

const clip = (text: string | null | undefined) => (text ?? '').slice(0, 500);

/**
 * 최근 업무 오류 한 목록(보강 6, decisions/0070). 새 표 없이 오류를 이미 남기는 네 곳을 읽어 시각 순으로 합친다 —
 * 택배 수집 기록(sync_run outcome ERROR), VAN 대조 실행(FAILED), 주간 리포트(lastError — 보내면 비워진다), Outbox(FAILED).
 * 출처마다 최근 limit개(id 내림차순)를 읽고 합쳐 limit개. 이상 단말기 찾기는 실행 기록 표가 없어(Redis 잠금만) 빠진다.
 * sync_run은 job 실행마다 한 행이라 가장 크다 — 가장 큰 id에서 SYNC_RUN_SCAN_WINDOW행 안(PK 범위)만 본다. 그보다 오래된 수집 오류는 이 목록에 없다(대가).
 */
@Injectable()
export class OpsErrorsService {
  constructor(private readonly em: EntityManager) {}

  async recent(limit: number): Promise<OpsErrorView[]> {
    const em = this.em.fork();
    const desc = { orderBy: { id: 'desc' as const }, limit };
    // findOne은 빈 조건({})을 거절한다(MikroORM validateEmptyWhere) — 가장 큰 id 한 행은 find + limit 1로
    const [last] = await em.find(SyncRun, {}, { orderBy: { id: 'desc' }, limit: 1, fields: ['id'] });
    const [syncRuns, vanRuns, reports, outbox] = await Promise.all([
      last ? em.find(SyncRun, { outcome: 'ERROR', id: { $gt: last.id - SYNC_RUN_SCAN_WINDOW } }, desc) : Promise.resolve([]),
      em.find(VanReconciliationRun, { status: VanRunStatus.FAILED }, desc),
      em.find(WeeklyReport, { lastError: { $ne: null } }, { ...desc, exclude: ['file'] }),
      em.find(OutboxEvent, { status: OutboxStatus.FAILED }, desc),
    ]);
    const rows: OpsErrorView[] = [
      ...syncRuns.map((r) => ({
        source: 'SYNC_RUN' as const,
        id: r.id,
        at: r.startedAt.toISOString(),
        title: `택배 수집 실패 — ${r.job}${r.shipment ? ` 운송장 #${r.shipment.id}` : ''}, ${r.attempt}번째 시도`,
        message: clip(r.detail),
      })),
      ...vanRuns.map((r) => ({
        source: 'VAN_RUN' as const,
        id: r.id,
        at: (r.finishedAt ?? r.startedAt).toISOString(),
        title: `VAN 대조 #${r.id} 실패 — ${r.trigger === 'SCHEDULED' ? '주기 실행' : `${r.requestedBy} 실행`}`,
        message: clip(r.error),
      })),
      ...reports.map((r) => ({
        source: 'WEEKLY_REPORT' as const,
        id: r.id,
        at: (r.generatedAt ?? r.createdAt).toISOString(),
        title: `주간 리포트 ${r.weekStart} 주 보내기 실패 — ${r.status}, ${r.attempts}번 시도`,
        message: clip(r.lastError),
      })),
      ...outbox.map((r) => ({
        source: 'OUTBOX' as const,
        id: r.id,
        at: r.createdAt.toISOString(),
        title: `알림 #${r.id} 보내기 실패 — ${r.type}, ${r.attempts}번 시도`,
        message: clip(r.lastError),
      })),
    ];
    // 같은 시각이면 출처·id 순으로 정해 두어 목록이 매번 같게
    return rows.sort((a, b) => b.at.localeCompare(a.at) || a.source.localeCompare(b.source) || b.id - a.id).slice(0, limit);
  }
}
