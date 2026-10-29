/** 시간 제한에 걸렸을 때 던지는 오류. 관제 화면에는 이름(`TIMEOUT`)만 보인다 */
export class OpsTimeoutError extends Error {
  override name = 'TIMEOUT';
}

/**
 * p가 ms 안에 끝나지 않으면 OpsTimeoutError로 던진다(Task 1 리뷰 반영, decisions/0071).
 * BullMQ Queue 연결은 ioredis 기본값(maxRetriesPerRequest 20·오프라인 큐)이라 Redis가 느리거나 죽으면 명령이 몇 분 기다린다 —
 * 관제 읽기는 그만큼 기다리지 않고 먼저 답한다. 원래 명령을 취소하지는 않는다(뒤에 끝나거나 실패해도 결과는 버린다 — race가 받아 둬 unhandled가 되지 않는다).
 */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OpsTimeoutError(`${what}: ${ms}ms 안에 답이 없습니다`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
