/** 연동하는 택배사 */
export enum Carrier {
  BUNGAE = 'BUNGAE', // 번개택배(JSON)
  NEURIMBO = 'NEURIMBO', // 느림보물류(XML)
}

/** 택배사마다 다른 상태 코드를 이 값으로 맞춘다(F12). */
export enum CarrierEventCode {
  PICKED_UP = 'PICKED_UP',
  IN_TRANSIT = 'IN_TRANSIT',
  OUT_FOR_DELIVERY = 'OUT_FOR_DELIVERY',
  DELIVERED = 'DELIVERED',
}

/** 택배사 응답을 변환한 배송 이벤트 */
export interface NormalizedEvent {
  /** 운송장 안에서 이벤트를 구분하는 키. 같은 키가 다시 오면 중복이다. */
  eventKey: string;
  code: CarrierEventCode;
  occurredAt: Date;
  /** 원본(디버깅·감사용) */
  raw: Record<string, unknown>;
}

export interface WaybillInput {
  /** 우리 쪽 참조 번호 */
  reference: string;
  receiverName: string;
  address: string;
}

/** 택배사 하나를 감싸는 어댑터. 택배사를 추가하면 이것만 하나 더 만든다. */
export interface CarrierAdapter {
  readonly carrier: Carrier;
  /** 운송장을 발급하고 운송장 번호를 돌려준다. */
  createWaybill(input: WaybillInput): Promise<string>;
  /** 지금까지의 배송 이벤트를 발생 시각 순으로 돌려준다. */
  track(trackingNo: string): Promise<NormalizedEvent[]>;
}
