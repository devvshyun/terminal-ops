/**
 * TanStack Query 키 한 곳(Day 6 최종 리뷰 Minor 4, decisions/0041 Day 7 보탬). 화면·컴포넌트는 키 글자를 직접 쓰지 않는다
 * (query-keys.test.ts가 소스를 읽어 확인한다).
 * - 첫 칸이 무효화 단위다. 목록 묶음은 복수(`terminals`, `purchase-orders` …), 한 건 묶음은 단수(`terminal`, `purchase-order` …).
 *   둘은 다른 키라 한쪽을 무효화해도 다른 쪽은 그대로다 — 쓰기 뒤에는 바뀐 것을 보여 주는 두 묶음을 모두 무효화한다.
 * - 쓰기 뒤에는 응답으로 캐시를 고치지 않고 무효화로 다시 읽는다(decisions/0041 Task 5 보탬).
 */
export const keys = {
  health: ['health'] as const,
  dashboard: ['dashboard'] as const,
  merchants: ['merchants'] as const,
  terminalModels: ['terminal-models'] as const,
  anomalyRules: ['anomaly-rules'] as const,
  inspectionItems: (modelCode: string) => ['inspection-items', modelCode] as const,

  /** 단말기 목록(쪽·조건마다) */
  terminals: {
    all: ['terminals'] as const,
    page: (filter: object, page: number) => ['terminals', filter, page] as const,
    /** A/S 교체 후보: 같은 모델의 재고 */
    stock: (modelCode: string | undefined) => ['terminals', { status: 'IN_STOCK', modelCode }] as const,
  },
  /** 단말기 한 대의 상세·이력·접속 상태·검수 기록. 여러 대가 바뀌는 작업(스캔·A/S) 뒤에는 all로 모두 */
  terminal: {
    all: ['terminal'] as const,
    one: (serialNo: string | undefined) => ['terminal', serialNo] as const,
    detail: (serialNo: string | undefined) => ['terminal', serialNo, 'detail'] as const,
    history: (serialNo: string | undefined) => ['terminal', serialNo, 'history'] as const,
    connectivity: (serialNo: string | undefined) => ['terminal', serialNo, 'connectivity'] as const,
    inspections: (serialNo: string | undefined) => ['terminal', serialNo, 'inspections'] as const,
  },
  purchaseOrders: {
    all: ['purchase-orders'] as const,
    /** 박스 스캔의 발주 선택지(ORDERED·RECEIVING) */
    open: ['purchase-orders', 'open'] as const,
  },
  purchaseOrder: {
    all: ['purchase-order'] as const,
    reconciliation: (poNo: string | null) => ['purchase-order', poNo, 'reconciliation'] as const,
  },
  serviceTickets: { all: ['service-tickets'] as const },
  serviceTicket: {
    all: ['service-ticket'] as const,
    one: (id: number) => ['service-ticket', id] as const,
  },
  rollouts: { all: ['firmware-rollouts'] as const },
  anomalies: {
    all: ['anomalies'] as const,
    list: (rule: string, open: string) => ['anomalies', rule, open] as const,
  },
  vanRuns: { all: ['van-runs'] as const },
  vanRun: {
    all: ['van-run'] as const,
    items: (id: number, kind: string, verified: string) => ['van-run', id, kind, verified] as const,
  },
  syncRuns: { all: ['sync-runs'] as const },
  weeklyReports: { all: ['weekly-reports'] as const },
};

/** "더 보기" 목록의 키: 묶음 키 뒤에 조건(api/lists.ts useBeforeIdList) */
export const keysetKey = (base: readonly string[], query: object) => [...base, query] as const;
