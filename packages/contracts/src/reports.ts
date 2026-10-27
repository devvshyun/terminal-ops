import type { AfterIdPage } from './common.js';
import type { AnomalyRule, SyncRunOutcome, TerminalStatus, VanMismatchKind, VanRunStatus, VanRunTrigger, WeeklyReportStatus } from './statuses.js';

/** GET /anomaly-rules — 규칙 이름·기준일(화면의 규칙 필터, decisions/0040) */
export interface AnomalyRuleView {
  rule: AnomalyRule;
  label: string;
  /** 기준일. 날짜 기준이 아닌 규칙(IN_SERVICE_NO_MERCHANT)은 null */
  days: number | null;
}

/** 이상 하나의 근거. 규칙마다 담는 것이 다르다(api anomaly-rules.ts) — 화면은 days만 쓴다 */
export type AnomalyDetail = Record<string, unknown> & { days?: number };

/** 이상 단말기 한 건(GET /anomalies, afterId 키셋) */
export interface AnomalyView {
  id: number;
  /** 단말기가 지워졌으면 null */
  serialNo: string | null;
  status: TerminalStatus | null;
  rule: AnomalyRule;
  ruleLabel: string;
  detectedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  detail: AnomalyDetail;
}

/** POST /anomaly-scans 응답(동기 찾기 한 번) */
export interface AnomalyScanSummary {
  detected: number;
  continuing: number;
  resolved: number;
  /** 찾기가 끝난 뒤 열린 이상 수(규칙별, 0인 규칙은 빠진다) */
  open: Partial<Record<AnomalyRule, number>>;
  /** 새로 걸린 단말기(최대 100) */
  newSerials: string[];
}

/** VAN 대조 실행(api toVanRunView) */
export interface VanRunView {
  id: number;
  status: VanRunStatus;
  trigger: VanRunTrigger;
  requestedBy: string;
  acknowledgeDrop: boolean;
  startedAt: string;
  heartbeatAt: string;
  finishedAt: string | null;
  pages: number;
  fetched: number;
  retries: number;
  candidates: number;
  confirmed: number;
  resolved: number;
  unverifiable: number;
  /** 어긋남 종류별 확정 수 */
  counts: Record<string, number>;
  /** 단계별 걸린 시간(ms) */
  phaseMs: { collect?: number; compare?: number; reverify?: number };
  error: string | null;
}

/** VAN 대조 결과 항목 하나 */
export interface VanItemView {
  id: number;
  serialNo: string;
  kind: VanMismatchKind;
  kindLabel: string;
  ourValue: string;
  vanValue: string;
  verified: boolean;
  reason: string | null;
}

/** GET /van-reconciliations/:id — 실행 요약 + 결과 한 쪽(?kind=&verified=&afterId=&limit=) */
export type VanRunDetail = VanRunView & AfterIdPage<VanItemView>;

/** 주간 리포트 주별 행(api toWeeklyReportView + 큐 상태, decisions/0038) */
export interface WeeklyReportView {
  /** 그 주 월요일(KST) YYYY-MM-DD */
  weekStart: string;
  status: WeeklyReportStatus;
  fileName: string | null;
  fileSize: number | null;
  generatedAt: string | null;
  sentAt: string | null;
  attempts: number;
  lastError: string | null;
  /** POST에서 이미 보낸 주라 job 없이 200 */
  alreadySent: boolean;
  /** 수동 보내기 job이 대기·처리 중 */
  queued: boolean;
  /** 그 job을 넣은 시각(대기·처리 중일 때만 ISO, POST 202 응답에는 null) */
  queuedAt: string | null;
}

/** GET /reports/weekly?before=YYYY-MM-DD (주 키셋) */
export interface WeeklyReportPage {
  items: WeeklyReportView[];
  nextBefore: string | null;
}

/** 택배 수집 job 실행 한 번(GET /sync-runs) */
export interface SyncRunView {
  id: number;
  /** 큐 이름(track-bungae, track-neurimbo) */
  job: string;
  shipmentId: number | null;
  trackingNo: string | null;
  attempt: number;
  worker: string;
  outcome: SyncRunOutcome;
  startedAt: string;
  finishedAt: string | null;
  fetched: number;
  inserted: number;
  duplicated: number;
  detail: string | null;
}

/** 어드민 처음 화면의 숫자 묶음(decisions/0044). 모두 집계 시각 기준 */
export interface DashboardSummary {
  terminals: {
    total: number;
    /** 상태 순서(전이 표의 enum 순서), 0대인 상태는 빠진다 */
    byStatus: { status: TerminalStatus; count: number }[];
    byModel: { modelCode: string; count: number }[];
  };
  /** 운영 중 단말기의 접속 상태(주간 리포트와 같은 MySQL 기준) */
  connectivity: { inService: number; online: number; offline: number; noRecord: number };
  /** 열린 이상(규칙 순서, 0인 규칙은 빠진다) */
  anomalies: { open: number; byRule: { rule: AnomalyRule; label: string; open: number }[] };
  /** 끝나지 않은 펌웨어 배포(RUNNING·PAUSED) */
  rollouts: { active: number };
  /** 열린 A/S(OPEN·REPLACING) */
  serviceTickets: { open: number };
  /** 가장 최근에 끝난(COMPLETED) VAN 대조 */
  van: { runId: number; finishedAt: string; confirmed: number; counts: Record<string, number> } | null;
  /** 이번 주(KST 월요일 00:00부터 집계 시각까지) 상태 전이 수 */
  week: { weekStart: string; transitions: number };
}

/** GET /dashboard/summary — 집계 + 그 집계를 만든 시각, 이번 응답이 캐시에서 왔는지 */
export interface DashboardView extends DashboardSummary {
  cachedAt: string;
  fromCache: boolean;
}

/** GET /health */
export interface HealthView {
  status: 'ok';
}
