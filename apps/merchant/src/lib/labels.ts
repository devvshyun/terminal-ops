import type { Carrier, CarrierEventCode, ServiceTicketStatus, TerminalStatus } from '@terminal-ops/contracts';

/**
 * 점주에게 보이는 이름(decisions/0060). 어드민 lib/labels.ts(운영자 용어)와 일부러 다르다 — 점주는 "배정·회수 요청" 같은 본사 업무 단계가 아니라
 * "언제 오나, 쓸 수 있나, 무엇을 하면 되나"를 본다. 키는 contracts의 상태 유니온 — 상태가 늘면 여기서 tsc가 빠진 이름을 알려 준다.
 * 점주에게 보이지 않는 상태(입고·검수·재고·불량·폐기, api MERCHANT_VISIBLE_STATUSES 밖)도 Record라 이름은 둔다(화면에 나오지 않는다).
 */
export const TERMINAL_STATUS_LABEL: Record<TerminalStatus, string> = {
  RECEIVED: '본사 입고',
  INSPECTED: '본사 검수 완료',
  DEFECTIVE: '본사 불량 처리',
  IN_STOCK: '본사 보관',
  ALLOCATED: '보낼 준비 중',
  SHIPPED: '배송 중',
  DELIVERED: '도착(설치 전)',
  IN_SERVICE: '사용 중',
  RETURN_REQUESTED: '회수 준비 중',
  RETURNING: '회수 중',
  RETURNED: '회수 완료',
  DISPOSED: '본사 폐기',
};

/** 상태 배지 색(ok 초록·warn 노랑·danger 빨강, 없으면 회색) */
export const TERMINAL_STATUS_TONE: Partial<Record<TerminalStatus, 'ok' | 'warn' | 'danger'>> = {
  IN_SERVICE: 'ok',
  SHIPPED: 'warn',
  DELIVERED: 'warn',
  ALLOCATED: 'warn',
  RETURN_REQUESTED: 'danger',
  RETURNING: 'danger',
};

/** 단말기 상세의 "지난 일" 한 줄 — 상태가 된 순간을 점주 말로 */
export const TERMINAL_EVENT_LABEL: Record<TerminalStatus, string> = {
  RECEIVED: '본사 입고',
  INSPECTED: '본사 검수',
  DEFECTIVE: '본사 불량 판정',
  IN_STOCK: '본사 보관',
  ALLOCATED: '우리 매장으로 배정',
  SHIPPED: '택배 출발',
  DELIVERED: '매장 도착',
  IN_SERVICE: '설치 완료',
  RETURN_REQUESTED: '회수 요청(고장 단말기)',
  RETURNING: '기사님 수거',
  RETURNED: '본사 도착(회수 완료)',
  DISPOSED: '본사 폐기',
};

/** 회수 중인 단말기에 붙이는 안내 — 점주가 할 일 */
export const RETURN_GUIDE: Partial<Record<TerminalStatus, string>> = {
  RETURN_REQUESTED: '고장 단말기를 상자에 담아 두세요. 기사님이 방문해 수거합니다.',
  RETURNING: '기사님이 수거했습니다. 본사에 도착하면 회수 완료로 바뀝니다.',
  RETURNED: '본사에 도착했습니다. 더 하실 일은 없습니다.',
};

export const TICKET_STATUS_LABEL: Record<ServiceTicketStatus, string> = {
  OPEN: '확인 중',
  RESOLVED_REMOTELY: '원격으로 해결',
  REPLACING: '교체 진행 중',
  CLOSED: '완료',
};

export const CARRIER_LABEL: Record<Carrier, string> = {
  BUNGAE: '번개택배',
  NEURIMBO: '느림보물류',
};

/** 택배 단계(택배사 이벤트 코드) */
export const CARRIER_EVENT_LABEL: Record<CarrierEventCode, string> = {
  PICKED_UP: '택배사 인수',
  IN_TRANSIT: '이동 중',
  OUT_FOR_DELIVERY: '배송 출발',
  DELIVERED: '배송 완료',
};

/** 고장 증상 고르기(A/S 접수). 고른 것과 메모를 "증상: 메모"로 이어 symptom(200자)에 넣는다 — 서버 칸은 글 하나다(decisions/0060) */
export const SYMPTOMS = ['카드 인식 안 됨', '영수증 출력 안 됨', '전원 안 켜짐', '통신 연결 안 됨', '화면·버튼 이상', '기타'] as const;
