import type { MerchantTerminalDetail, MerchantTerminalView, MerchantTicketView } from '@terminal-ops/contracts';

/** 서버 GET /me/terminals 한 줄 모양(api toMerchantTerminalView). 기본은 사용 중·연결됨 */
export const terminal = (over: Partial<MerchantTerminalView> = {}): MerchantTerminalView => ({
  serialNo: 'SN-0001',
  modelCode: 'SN-100',
  modelName: '단말온 S100',
  status: 'IN_SERVICE',
  statusChangedAt: '2026-10-20T01:00:00.000Z',
  connectivity: { online: true, lastSeenAt: '2026-10-28T02:58:00.000Z', firmwareVersion: '1.2.0' },
  shipment: null,
  ...over,
});

export const terminalDetail = (over: Partial<MerchantTerminalDetail> = {}): MerchantTerminalDetail => ({
  ...terminal(),
  events: [
    { status: 'ALLOCATED', occurredAt: '2026-10-18T01:00:00.000Z' },
    { status: 'SHIPPED', occurredAt: '2026-10-18T03:00:00.000Z' },
    { status: 'DELIVERED', occurredAt: '2026-10-19T05:00:00.000Z' },
    { status: 'IN_SERVICE', occurredAt: '2026-10-20T01:00:00.000Z' },
  ],
  ...over,
});

/** 서버 /me/service-tickets 한 줄 모양(api toMerchantTicketView). 기본은 막 접수한 것 */
export const ticket = (over: Partial<MerchantTicketView> = {}): MerchantTicketView => ({
  id: 7,
  serialNo: 'SN-0001',
  merchantCode: 'GANGNAM-KIMBAP',
  symptom: '카드 인식 안 됨: 오전부터',
  status: 'OPEN',
  replacementSerialNo: null,
  outboundShipmentId: null,
  outboundTrackingNo: null,
  openedByMe: true,
  remoteChecked: false,
  replacementStatus: null,
  createdAt: '2026-10-28T01:00:00.000Z',
  closedAt: null,
  ...over,
});

/** 빈 목록 응답 */
export const page = <T>(items: T[]) => ({ items, total: items.length, page: 1, size: 100 });
export const keyset = <T>(items: T[]) => ({ items, nextBeforeId: null });
