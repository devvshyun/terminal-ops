import { UniqueConstraintViolationException } from '@mikro-orm/mysql';

/**
 * unique 위반이면 처음부터 한 번 더 한다. 일괄 등록은 "기존 시리얼 조회 → INSERT" 사이에 다른 요청이 같은 시리얼을 먼저
 * 넣을 수 있다. 다시 하면 조회에서 ALREADY_EXISTS로 걸러진다(decisions/0019). fn은 매번 새 트랜잭션을 열어야 한다.
 */
export async function retryOnUniqueViolation<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof UniqueConstraintViolationException) || attempt >= attempts) throw error;
    }
  }
}
