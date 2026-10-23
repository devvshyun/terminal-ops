import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers/test-app.js';

/**
 * 앱 DB 연결의 collation이 테이블 열(utf8mb4_0900_ai_ci)과 같아야 한다(troubleshooting/0008, decisions/0025).
 * 이 파일은 resetDatabase(schema.refresh)를 부르지 않는다. 그 연결은 `set names utf8mb4`로 0900_ai_ci가 되어 오류를 가리기 때문이다.
 * 트랜잭션 여러 개를 동시에 열어 풀 연결을 여러 개 새로 만들고, 모두 같은지 본다.
 */
describe('DB 연결 collation', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('새로 연 풀 연결마다 @@collation_connection이 utf8mb4_0900_ai_ci다', async () => {
    const rows = await Promise.all(
      Array.from({ length: 4 }, () =>
        t.orm.em.fork().transactional(async (tx) => {
          const [row] = await tx.execute<{ id: number | string; c: string }[]>('select connection_id() as id, @@collation_connection as c');
          // 트랜잭션을 잠깐 잡고 있어 다른 트랜잭션이 같은 연결을 쓰지 못하게 한다
          await new Promise((r) => setTimeout(r, 50));
          return row;
        }),
      ),
    );
    expect(new Set(rows.map((r) => String(r.id))).size).toBe(4);
    expect(rows.map((r) => r.c)).toEqual(Array(4).fill('utf8mb4_0900_ai_ci'));
  });
});
