import type { ChainableCommander } from 'ioredis';

/**
 * pipeline·multi를 보내고 결과 값 배열을 돌려준다. ioredis는 명령 하나가 실패해도 exec()를 거절하지 않고
 * 결과 배열에 [오류, 값]으로 담는다. 하나라도 실패했으면 그 오류를 던진다.
 */
export async function execOrThrow(batch: ChainableCommander): Promise<unknown[]> {
  const results = (await batch.exec()) ?? [];
  const failed = results.find(([error]) => error);
  if (failed) throw failed[0];
  return results.map(([, value]) => value);
}
