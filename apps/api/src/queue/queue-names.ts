/** BullMQ 큐 이름. 택배사마다 호출 한도가 달라 추적 큐를 따로 둔다(decisions/0013). */
export const QUEUE = {
  TRACK_BUNGAE: 'track-bungae',
  TRACK_NEURIMBO: 'track-neurimbo',
  CARRIER_SWEEP: 'carrier-sweep',
  OUTBOX: 'outbox',
  /** 접속 상태·펌웨어 배포의 주기 작업과 active 갱신(decisions/0028) */
  DEVICE: 'device',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export const ALL_QUEUES: QueueName[] = Object.values(QUEUE);
