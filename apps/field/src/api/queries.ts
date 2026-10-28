import { useQuery } from '@tanstack/react-query';
import type { FieldTodayView } from '@terminal-ops/contracts';
import { api } from './client';
import { keys } from './query-keys';

/** 오늘(KST) 내가 한 일(GET /field/today, decisions/0063) */
export function useToday() {
  return useQuery({ queryKey: keys.today, queryFn: () => api<FieldTodayView>('/field/today') });
}
