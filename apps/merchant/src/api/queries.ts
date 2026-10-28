import { useQuery } from '@tanstack/react-query';
import type { BeforeIdPage, MerchantTerminalDetail, MerchantTerminalPage, MerchantTicketView } from '@terminal-ops/contracts';
import { api } from './client';
import { keys } from './query-keys';

/** 한 번에 받는 단말기 수(서버 상한 100). 한 매장 단말기는 이보다 훨씬 적다 — 넘으면 홈이 "N대 중 100대" 안내 */
export const TERMINAL_PAGE = 100;
/** 받는 최근 접수 수(서버 상한 100). 진행 중인 것만 고를 때는 화면이 거른다(서버 상태 조건은 하나만 된다) */
export const RECENT_TICKETS = 50;

/** 매장 단말기 목록(홈·A/S 접수 화면이 같은 키로 쓴다) */
export function useMyTerminals() {
  return useQuery({ queryKey: keys.terminals, queryFn: () => api<MerchantTerminalPage>('/me/terminals', { query: { size: TERMINAL_PAGE } }) });
}

/** 단말기 하나(이번 배정부터의 이력 포함). 남의 것·본사로 돌아간 것은 404 */
export function useMyTerminal(serialNo: string) {
  return useQuery({ queryKey: keys.terminal(serialNo), queryFn: () => api<MerchantTerminalDetail>(`/me/terminals/${encodeURIComponent(serialNo)}`) });
}

/** 최근 A/S 접수(serialNo가 있으면 그 단말기 것만) */
export function useMyTickets(serialNo?: string) {
  return useQuery({
    queryKey: keys.tickets(serialNo),
    queryFn: () => api<BeforeIdPage<MerchantTicketView>>('/me/service-tickets', { query: { limit: RECENT_TICKETS, serialNo } }),
  });
}

/** A/S 접수 한 건 */
export function useMyTicket(id: number) {
  return useQuery({ queryKey: keys.ticket(id), queryFn: () => api<MerchantTicketView>(`/me/service-tickets/${id}`) });
}
