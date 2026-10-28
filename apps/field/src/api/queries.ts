import { useQuery } from '@tanstack/react-query';
import type { BeforeIdPage, FieldTodayView, PurchaseOrderStatus, PurchaseOrderView } from '@terminal-ops/contracts';
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
