import type { CarrierEventCode, MerchantShipmentView, MerchantTicketView } from '@terminal-ops/contracts';
import { CARRIER_EVENT_LABEL } from './labels';

/** 진행 단계 한 칸: 지난 단계(done), 지금 기다리는 단계(current), 아직(todo) */
export interface Step {
  label: string;
  state: 'done' | 'current' | 'todo';
}

/** 앞에서 n칸은 지남, 그다음 한 칸이 지금, 나머지는 아직. n이 칸 수 이상이면 모두 지남 */
function fill(labels: readonly string[], done: number): Step[] {
  return labels.map((label, i) => ({ label, state: i < done ? 'done' : i === done ? 'current' : 'todo' }));
}

/**
 * A/S 진행 단계(decisions/0060): 접수 → 원격 점검 → 교체 출고 → 배송 중 → 설치 확인 → 완료. 서버가 주는 상태 값(접수 상태, 원격 점검 여부,
 * 교체 단말기 상태)에서 화면이 만든다 — 서버에 "단계" 칸을 따로 두지 않는다. 원격으로 해결되면 세 칸(접수 → 원격 점검 → 원격으로 해결).
 * 원격 점검 없이 바로 교체한 접수도 교체 뒤에는 원격 점검 칸이 지난 것으로 보인다(점주에게는 "그 단계를 지났다"가 중요하다).
 */
export const TICKET_STEP_LABELS = ['접수', '원격 점검', '교체 출고', '배송 중', '설치 확인', '완료'] as const;

export function ticketSteps(t: Pick<MerchantTicketView, 'status' | 'remoteChecked' | 'replacementStatus'>): Step[] {
  switch (t.status) {
    case 'RESOLVED_REMOTELY':
      return fill(['접수', '원격 점검', '원격으로 해결'], 3);
    case 'CLOSED':
      return fill(TICKET_STEP_LABELS, TICKET_STEP_LABELS.length);
    case 'REPLACING':
      // 교체 단말기 상태는 교체 중일 때만 오고 아직 배정 단계(ALLOCATED)이거나 비어(null) 있으면 교체 출고 차례
      return fill(TICKET_STEP_LABELS, t.replacementStatus === 'DELIVERED' ? 4 : t.replacementStatus === 'SHIPPED' ? 3 : 2);
    case 'OPEN':
      return fill(TICKET_STEP_LABELS, t.remoteChecked ? 2 : 1);
  }
}

/** 설치 확인 버튼을 켤 때: 교체 진행 중이고 교체 단말기가 도착(DELIVERED)했을 때만. 서버도 같은 조건을 다시 검사한다(422) */
export function canConfirmInstall(t: Pick<MerchantTicketView, 'status' | 'replacementStatus'>): boolean {
  return t.status === 'REPLACING' && t.replacementStatus === 'DELIVERED';
}

const CARRIER_CODES: readonly CarrierEventCode[] = ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'];

/**
 * 택배 단계: 출고 → 택배사 인수 → 이동 중 → 배송 출발 → 배송 완료. 가장 멀리 간 이벤트까지 지난 것으로 본다(이벤트가 늦게·순서 없이 와도).
 * 운송장이 배송 완료(DELIVERED)면 이벤트가 없어도 모두 지남 — 운영자가 손으로 배송 완료를 넣는 경우가 있다.
 */
export function shipmentSteps(s: Pick<MerchantShipmentView, 'status' | 'events'>): Step[] {
  const labels = ['출고', ...CARRIER_CODES.map((c) => CARRIER_EVENT_LABEL[c])];
  if (s.status === 'DELIVERED') return fill(labels, labels.length);
  const furthest = Math.max(-1, ...s.events.map((e) => CARRIER_CODES.indexOf(e.code)));
  return fill(labels, furthest + 2);
}
