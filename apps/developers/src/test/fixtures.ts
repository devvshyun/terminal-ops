import type { BeforeIdPage, PartnerCallView, PartnerKeyView, PartnerView } from '@terminal-ops/contracts';

/** 지금보다 m분 전 ISO 시각(화면의 "N분 전"이 테스트 시각과 상관없이 같게) */
export const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

export const partner = (over: Partial<PartnerView> = {}): PartnerView => ({
  id: 1,
  code: 'HANOL-POS',
  name: '한올POS',
  memo: '가맹점 POS 연동',
  activeKeys: 1,
  totalKeys: 2,
  lastUsedAt: minutesAgo(5),
  createdBy: 'admin',
  createdAt: minutesAgo(3000),
  ...over,
});

export const partnerKey = (over: Partial<PartnerKeyView> = {}): PartnerKeyView => ({
  id: 11,
  partnerId: 1,
  partnerCode: 'HANOL-POS',
  partnerName: '한올POS',
  name: '운영 서버',
  prefix: 'pk_a1b2c3d4',
  scopes: ['terminal-status:read'],
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: minutesAgo(5),
  createdBy: 'admin',
  createdAt: minutesAgo(2000),
  ...over,
});

export const call = (over: Partial<PartnerCallView> = {}): PartnerCallView => ({
  id: 100,
  partnerId: 1,
  partnerCode: 'HANOL-POS',
  keyId: 11,
  keyPrefix: 'pk_a1b2c3d4',
  method: 'GET',
  path: '/partner/v1/terminals/SN100-2610-00401',
  status: 200,
  durationMs: 12,
  createdAt: minutesAgo(5),
  ...over,
});

export const callPage = (items: PartnerCallView[], nextBeforeId: number | null = null): BeforeIdPage<PartnerCallView> => ({ items, nextBeforeId });

/** 처음 화면(업체 목록)이 부르는 것 */
export const partnersApi = (list: PartnerView[] = [partner()]) => ({
  'GET /admin/partners': () => ({ body: list }),
});
