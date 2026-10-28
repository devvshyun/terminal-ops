import { useQuery } from '@tanstack/react-query';
import type { BeforeIdPage, FieldTodayView, InspectionItemView, PurchaseOrderStatus, PurchaseOrderView, TerminalDetail, TerminalPage, TerminalView } from '@terminal-ops/contracts';
import { INSPECTION_QUEUE_STATUSES } from '../lib/labels';
import { api } from './client';
import { keys } from './query-keys';

/** 오늘(KST) 내가 한 일(GET /field/today, decisions/0063) */
export function useToday() {
  return useQuery({ queryKey: keys.today, queryFn: () => api<FieldTodayView>('/field/today') });
}

/** 열린 발주 상태. 상태별로 따로 불러 합친다 — 최근 100개를 받아 거르면 마감된 발주가 쌓였을 때 오래된 열린 발주가 잘린다(어드민 ScanPage와 같은 이유) */
const OPEN_PO_STATUSES = ['ORDERED', 'RECEIVING'] as const satisfies readonly PurchaseOrderStatus[];

/** 발주분 입고에서 고를 열린 발주(최근 발주부터). 상태별 100개를 넘으면 잘리고 truncated가 true */
export function useOpenOrders(enabled: boolean) {
  return useQuery({
    queryKey: keys.openOrders,
    queryFn: async () => {
      const pages = await Promise.all(
        OPEN_PO_STATUSES.map((status) => api<BeforeIdPage<PurchaseOrderView>>('/purchase-orders', { query: { status, limit: 100 } })),
      );
      return { items: pages.flatMap((p) => p.items).sort((a, b) => b.id - a.id), truncated: pages.some((p) => p.nextBeforeId !== null) };
    },
    enabled,
  });
}

/** 검수 대기 한 묶음: 오래 기다린 것부터(지금 상태가 된 시각 오름차순). total은 상태별 전체 수의 합 — 상태별 100대까지만 받는다 */
export interface InspectionQueue {
  items: TerminalView[];
  total: number;
}

/**
 * 검수 대기(RECEIVED·RETURNED). 기존 단말기 목록 API를 상태마다 한 번씩 부른다(decisions/0063 — 전용 엔드포인트를 만들지 않음).
 * 목록 API는 최근 등록 순이라 합친 뒤 오래 기다린 것부터 다시 줄 세운다.
 */
export function useInspectionQueue() {
  return useQuery({
    queryKey: keys.queue,
    queryFn: async (): Promise<InspectionQueue> => {
      const pages = await Promise.all(INSPECTION_QUEUE_STATUSES.map((status) => api<TerminalPage>('/terminals', { query: { status, size: 100 } })));
      const items = pages.flatMap((p) => p.items).sort((a, b) => a.statusChangedAt.localeCompare(b.statusChangedAt) || a.serialNo.localeCompare(b.serialNo));
      return { items, total: pages.reduce((n, p) => n + p.total, 0) };
    },
  });
}

/** 단말기 한 대(검수할 수 있는지는 서버가 계산한 actions.inspect — decisions/0040) */
export function useTerminal(serialNo: string) {
  return useQuery({ queryKey: keys.terminal(serialNo), queryFn: () => api<TerminalDetail>(`/terminals/${encodeURIComponent(serialNo)}`) });
}

/** 모델별 검수 항목(바뀌는 일이 드물어 staleTime 무한) */
export function useInspectionItems(modelCode: string | undefined) {
  return useQuery({
    queryKey: keys.items(modelCode ?? ''),
    queryFn: () => api<InspectionItemView[]>('/inspection-items', { query: { modelCode } }),
    enabled: modelCode !== undefined,
    staleTime: Infinity,
  });
}
