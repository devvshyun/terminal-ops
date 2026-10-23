import { DeadlockException, UniqueConstraintViolationException } from '@mikro-orm/mysql';

/** 다시 하면 풀리는 쓰기 충돌인가: unique 위반, 데드락(1213) */
const isRetryable = (error: unknown) => error instanceof UniqueConstraintViolationException || error instanceof DeadlockException;

/**
 * unique 위반이나 데드락이면 처음부터 다시 한다(기본 3번까지, 사이에 20~80ms 무작위 대기).
 * 일괄 등록은 "기존 시리얼 조회 → INSERT" 사이에 다른 요청이 같은 시리얼을 먼저 넣을 수 있다. 다시 하면 조회에서
 * ALREADY_EXISTS로 걸러진다. 겹친 요청이 셋이면 두 번째 시도에서 또 질 수 있어 3번이다(decisions/0019).
 * fn은 매번 새 fork와 새 트랜잭션을 열어야 한다(실패한 Unit of Work를 다시 쓰지 않는다).
 */
export async function retryOnUniqueViolation<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryable(error) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 60));
    }
  }
}
