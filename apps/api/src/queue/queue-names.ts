/** BullMQ 큐 이름. 택배사마다 호출 한도가 달라 추적 큐를 따로 둔다(decisions/0013). */
export const QUEUE = {
  TRACK_BUNGAE: 'track-bungae',
  TRACK_NEURIMBO: 'track-neurimbo',
  CARRIER_SWEEP: 'carrier-sweep',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export const ALL_QUEUES: QueueName[] = Object.values(QUEUE);
