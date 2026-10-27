/** api 응답 모양(서버의 *.views.ts·toXxxView와 같게 둔다). 화면이 쓰는 필드만 */

export interface TerminalView {
  serialNo: string;
  modelCode: string;
  merchantCode: string | null;
  status: string;
  statusChangedAt: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TerminalPage {
  items: TerminalView[];
  total: number;
  page: number;
  size: number;
}

/** 지금 상태에서 일반 전이로 갈 수 있는 상태. 모델 정책에 막혔으면 이유(decisions/0040) */
export interface TransitionTarget {
  to: string;
  blockedReason: string | null;
}

export interface TerminalDetail extends TerminalView {
  modelName: string;
  merchantName: string | null;
  allowedTransitions: TransitionTarget[];
  actions: { allocate: boolean; cancelAllocation: boolean; ship: boolean; inspect: boolean };
}

export interface HistoryView {
  fromStatus: string | null;
  toStatus: string;
  source: string;
  actor: string;
  reason: string;
  occurredAt: string;
}

export interface ConnectivityView {
  serialNo: string;
  source: 'redis' | 'snapshot' | 'none';
  online: boolean;
  lastSeenAt: string | null;
  firmwareVersion: string | null;
}

export interface InspectionRecord {
  id: number;
  passed: boolean;
  actor: string;
  inspectedAt: string;
  results: { itemCode: string; label: string; passed: boolean; note: string | null }[];
}

export interface InspectionItemView {
  code: string;
  label: string;
  sortOrder: number;
}

export interface MerchantView {
  code: string;
  name: string;
  address: string;
}

export interface TerminalModelView {
  code: string;
  name: string;
  requiresReinspection: boolean;
}

/** 최근 것부터 "더 보기" 목록(decisions/0039) */
export interface BeforeIdPage<T> {
  items: T[];
  nextBeforeId: number | null;
}

/** 주간 리포트 주별 행(서버 toWeeklyReportView + 큐 상태, decisions/0038) */
export interface WeeklyReportView {
  weekStart: string;
  status: string;
  fileName: string | null;
  fileSize: number | null;
  generatedAt: string | null;
  sentAt: string | null;
  attempts: number;
  lastError: string | null;
  alreadySent: boolean;
  queued: boolean;
  /** 수동 보내기 job을 넣은 시각(대기·처리 중일 때만 ISO, POST 202 응답에는 null) */
  queuedAt: string | null;
}

/** 처음 화면의 운영 현황(서버 GET /dashboard/summary, api decisions/0044). cachedAt = 서버가 이 집계를 만든 시각 */
export interface DashboardView {
  terminals: {
    total: number;
    byStatus: { status: string; count: number }[];
    byModel: { modelCode: string; count: number }[];
  };
  connectivity: { inService: number; online: number; offline: number; noRecord: number };
  anomalies: { open: number; byRule: { rule: string; label: string; open: number }[] };
  rollouts: { active: number };
  serviceTickets: { open: number };
  van: { runId: number; finishedAt: string; confirmed: number; counts: Record<string, number> } | null;
  week: { weekStart: string; transitions: number };
  cachedAt: string;
  fromCache: boolean;
}
