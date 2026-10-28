import type { ConnectivityView, MerchantShipmentView, MerchantTerminalEvent, MerchantTerminalView } from '@terminal-ops/contracts';
import { MERCHANT_VISIBLE_STATUSES } from '../merchant/merchant-scope.js';
import type { CarrierEvent, Shipment } from '../shipment/shipment.entities.js';
import type { Terminal } from '../terminal/terminal.entity.js';
import type { TerminalStatusHistory } from '../terminal/terminal-status-history.entity.js';
import { TerminalStatus } from '../terminal/terminal-status.js';

/**
 * 가맹점주 화면용 응답(보강 3, decisions/0059). 운영자용 view를 펼치지 않고 필드를 하나씩 옮긴다 —
 * 운영자용 모양에 필드가 늘어도 점주에게 저절로 나가지 않게(toMerchantTicketView와 같은 방식, decisions/0053).
 * terminal은 model이 populate돼 있어야 한다.
 */
export function toMerchantTerminalView(
  t: Terminal,
  connectivity: ConnectivityView | null,
  shipment: MerchantShipmentView | null,
): MerchantTerminalView {
  return {
    serialNo: t.serialNo,
    modelCode: t.model.code,
    modelName: t.model.name,
    status: t.status,
    statusChangedAt: t.statusChangedAt.toISOString(),
    connectivity:
      t.status === TerminalStatus.IN_SERVICE && connectivity
        ? { online: connectivity.online, lastSeenAt: connectivity.lastSeenAt, firmwareVersion: connectivity.firmwareVersion }
        : null,
    shipment,
  };
}

/** 운송장 + 택배 이벤트(오래된 것부터 넘긴다) + 교체 출고면 접수 번호 */
export function toMerchantShipmentView(s: Shipment, events: CarrierEvent[], ticketId: number | null): MerchantShipmentView {
  return {
    carrier: s.carrier,
    trackingNo: s.trackingNo,
    status: s.status,
    createdAt: s.createdAt.toISOString(),
    deliveredAt: s.deliveredAt?.toISOString() ?? null,
    ticketId,
    events: events.map((e) => ({ code: e.code, occurredAt: e.occurredAt.toISOString() })),
  };
}

/**
 * 상태 이력 중 이번 배정(마지막 ALLOCATED)부터만, 상태와 시각만. 단말기가 회수돼 다른 가맹점에 다시 배정되면
 * 그 단말기의 앞 이력(옛 가맹점의 설치·회수)은 지금 가맹점과 상관없는 남의 기록이라 주지 않는다. 점주에게 보이는 상태만 남긴다
 * (배정 이력이 없는 단말기 — 데이터를 손으로 넣은 경우 — 에서 입고·검수 같은 본사 단계가 나가지 않게). history는 id 오름차순.
 */
export function merchantEvents(history: TerminalStatusHistory[]): MerchantTerminalEvent[] {
  const start = history.findLastIndex((h) => h.toStatus === TerminalStatus.ALLOCATED);
  return history
    .slice(Math.max(start, 0))
    .filter((h) => MERCHANT_VISIBLE_STATUSES.includes(h.toStatus))
    .map((h) => ({ status: h.toStatus, occurredAt: h.occurredAt.toISOString() }));
}

/**
 * 접속 요약을 이번 배정(마지막 ALLOCATED) 기준으로 자른다: 마지막 접속이 이번 배정보다 앞이면 앞 주기(옛 가맹점)의 값이라
 * 마지막 접속·펌웨어를 비우고 오프라인으로 준다. 이번 주기에 하트비트가 아직 없는 단말기와 같은 모양이다.
 * 배정 이력이 없으면(데이터를 손으로 넣은 경우) 자르지 않는다.
 */
export function currentCycleConnectivity(c: ConnectivityView, allocatedAt: Date | undefined): ConnectivityView {
  if (!allocatedAt || c.lastSeenAt === null || new Date(c.lastSeenAt).getTime() >= allocatedAt.getTime()) return c;
  return { ...c, online: false, lastSeenAt: null, firmwareVersion: null };
}
