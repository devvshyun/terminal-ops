import type { MikroORM } from '@mikro-orm/mysql';

interface LoggingConnection {
  logQuery(query: string, context?: unknown): void;
}

/**
 * MikroORM이 보내는 SQL을 센다(begin·commit 포함). 연결 객체의 logQuery를 잠깐 감싼다 — debug 설정과 상관없이
 * 모든 쿼리가 이 함수를 거친다(@mikro-orm/core Connection.executeQuery). 다 쓰면 stop()으로 되돌린다 — 측정 코드가 실패해도
 * 되돌리도록 try/finally에서 부른다.
 *
 * 연결 객체 하나를 통째로 감싸므로 그 사이 같은 앱에서 나간 쿼리가 모두 섞인다. 워커·스케줄러(Outbox relay, 큐 소비자 등)가
 * 꺼진 테스트 앱에서만 숫자가 맞다(`createTestApp()` 기본값. `{ workers: true }`로 띄운 앱에서는 쓰지 않는다).
 */
export function captureQueries(orm: MikroORM) {
  const conn = orm.em.getConnection() as unknown as LoggingConnection;
  const original = conn.logQuery;
  const queries: string[] = [];
  /** 값까지 채워 실제로 보낸 SQL(MikroORM이 context.formatted로 넘김). raw() 값이 어떻게 들어갔는지 볼 때 쓴다 */
  const formatted: string[] = [];
  conn.logQuery = function (query: string, context?: unknown) {
    queries.push(query);
    formatted.push((context as { formatted?: string } | undefined)?.formatted ?? query);
    return original.call(this, query, context);
  };
  return {
    queries,
    formatted,
    /** select로 시작하는 쿼리 수 */
    selects: () => queries.filter((q) => /^select /i.test(q)).length,
    stop: () => {
      conn.logQuery = original;
    },
  };
}
