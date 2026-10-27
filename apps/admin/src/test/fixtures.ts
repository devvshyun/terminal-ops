import type { DashboardView } from '@terminal-ops/contracts';

/** 서버 GET /dashboard/summary 응답 모양(api DashboardView, decisions/0044) — 처음 화면을 그리는 테스트가 함께 쓴다 */
export const dashboardBody = (over: Partial<DashboardView> = {}): DashboardView => ({
  terminals: {
    total: 6,
    byStatus: [
      { status: 'IN_STOCK', count: 2 },
      { status: 'IN_SERVICE', count: 3 },
      { status: 'DISPOSED', count: 1 },
    ],
    byModel: [
      { modelCode: 'SN-100', count: 4 },
      { modelCode: 'SN-200', count: 2 },
    ],
  },
  connectivity: { inService: 3, online: 1, offline: 1, noRecord: 1 },
  anomalies: {
    open: 3,
    byRule: [
      { rule: 'RETURN_STALLED', label: '회수 지연', open: 1 },
      { rule: 'OFFLINE_TOO_LONG', label: '장기 오프라인', open: 2 },
    ],
  },
  rollouts: { active: 2 },
  serviceTickets: { open: 4 },
  van: { runId: 12, finishedAt: '2026-10-27T03:00:00.000Z', confirmed: 7, counts: { NOT_REGISTERED: 7 } },
  week: { weekStart: '2026-10-26', transitions: 15 },
  cachedAt: '2026-10-27T05:00:00.000Z',
  fromCache: true,
  ...over,
});
