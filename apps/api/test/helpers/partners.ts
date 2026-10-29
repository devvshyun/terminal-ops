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
  status429Limit: number;
  status429Forced: number;
  status5xx: number;
  overlaps: number;
  maxInFlight: number;
  /** 지금 처리 중인 번개 추적 조회 수(전체) */
  inFlightTotal: number;
  /** 운송장 구분 없이 동시에 처리한 번개 추적 조회 수의 최댓값 */
  maxInFlightTotal: number;
  /** 스캔 도중 변경으로 바뀐 브릿지VAN 등록 수, 그중 healTo로 고쳐진 수 */
  vanMutated: number;
  vanHealed: number;
}

/** 브릿지VAN에 심는 등록(apps/partners/src/state.ts의 VanRegistration) */
export interface VanSeed {
  tid: string;
  serialNo: string;
  merchantCode: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';
  registeredAt?: string;
  /** 스캔 도중 변경(mutateDuringScan)이 고를 때 바꿀 값 */
  healTo?: { status?: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED'; merchantCode?: string };
}

export interface ToktokSummary {
  total: number;
  byKey: Record<string, number>;
  messages: {
    channel: string;
    idempotencyKey: string;
    text: string;
    receivedAt: string;
    attachments: { fileId: string; fileName: string; size: number }[];
  }[];
  /** 올린 파일 수 */
  files: number;
}

export const partners = {
  reset: () => call<unknown>('POST', '/__admin/reset'),
  configure: (patch: Record<string, unknown>) => call<unknown>('POST', '/__admin/config', patch),
  /** 지금 설정(보강 8 GET /__admin/config) */
  config: () => call<{ seum: { shortfall: number } } & Record<string, unknown>>('GET', '/__admin/config'),
  stats: () => call<PartnersStats>('GET', '/__admin/stats'),
  toktok: () => call<ToktokSummary>('GET', '/__admin/toktok/messages'),
  /** 톡톡메신저에 올라간 첨부 파일 내용 */
  toktokFile: async (fileId: string) => {
    const res = await fetch(`${env.partnersUrl}/__admin/toktok/files/${encodeURIComponent(fileId)}`);
    if (!res.ok) throw new Error(`partners toktok file ${fileId} → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },
  /** 브릿지VAN 등록을 심는다(replace 기본 true: 기존 등록을 지우고) */
  seedVan: (registrations: VanSeed[], replace = true) =>
    call<{ count: number }>('POST', '/__admin/bridgevan/registrations', { registrations, replace }),
  /** 세움전자 납품 명세(테스트가 "공장이 보낸 박스"를 만들 때 쓴다). 호출 수(seum.deliveryNote)에 더해진다. */
  deliveryNote: (poNo: string) =>
    call<{ poNo: string; serials: string[] }>('GET', `/seum/v1/purchase-orders/${encodeURIComponent(poNo)}/delivery-note`),
};
