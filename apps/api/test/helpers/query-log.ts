import type { MikroORM } from '@mikro-orm/mysql';

interface LoggingConnection {
  logQuery(query: string, context?: unknown): void;
}

/**
 * MikroORM이 보내는 SQL을 센다(begin·commit 포함). 연결 객체의 logQuery를 잠깐 감싼다 — debug 설정과 상관없이
 * 모든 쿼리가 이 함수를 거친다(@mikro-orm/core Connection.executeQuery). 다 쓰면 stop()으로 되돌린다.
 */
export function captureQueries(orm: MikroORM) {
  const conn = orm.em.getConnection() as unknown as LoggingConnection;
  const original = conn.logQuery;
  const queries: string[] = [];
  conn.logQuery = function (query: string, context?: unknown) {
    queries.push(query);
    return original.call(this, query, context);
  };
  return {
    queries,
    /** select로 시작하는 쿼리 수 */
    selects: () => queries.filter((q) => /^select /i.test(q)).length,
    stop: () => {
      conn.logQuery = original;
    },
  };
}
