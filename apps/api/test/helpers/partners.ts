import { env } from '../../src/config/env.js';

/** 가상 업체 서버 관리 API 클라이언트. 설정 키는 apps/partners/src/state.ts의 PartnersConfig를 따른다. */
async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${env.partnersUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`partners ${method} ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export interface PartnersStats {
  calls: Record<string, number>;
  perTracking: Record<string, number>;
  status429: number;
  status5xx: number;
  overlaps: number;
  maxInFlight: number;
}

export interface ToktokSummary {
  total: number;
  byKey: Record<string, number>;
  messages: { channel: string; idempotencyKey: string; text: string; receivedAt: string }[];
}

export const partners = {
  reset: () => call<unknown>('POST', '/__admin/reset'),
  configure: (patch: Record<string, unknown>) => call<unknown>('POST', '/__admin/config', patch),
  stats: () => call<PartnersStats>('GET', '/__admin/stats'),
  toktok: () => call<ToktokSummary>('GET', '/__admin/toktok/messages'),
};
