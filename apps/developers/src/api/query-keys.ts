/**
 * 쿼리 키. 모두 'developers'로 시작한다(관제 앱과 같은 방식 — 화면이 몇 개 안 된다).
 * 작업 뒤에는 그 작업이 바꾸는 것만 무효화한다: 업체 등록 → 업체 목록, 키 발급·폐기 → 그 업체 키 목록·업체 목록(키 수).
 */
export const keys = {
  all: ['developers'] as const,
  partners: ['developers', 'partners'] as const,
  keysAll: ['developers', 'keys'] as const,
  keys: (partnerId: number) => ['developers', 'keys', partnerId] as const,
  callsAll: ['developers', 'calls'] as const,
  calls: (filter: { partnerId?: number; limit?: number }) => ['developers', 'calls', filter] as const,
  docs: ['developers', 'docs'] as const,
};
