import { describe, expect, it } from 'vitest';
import { Migration20261022053251 } from '../../src/migrations/Migration20261022053251.js';
import { Migration20261023015811 } from '../../src/migrations/Migration20261023015811.js';

/**
 * 최종 리뷰 반영(Minor 3, troubleshooting/0025): enum을 좁히는 down은 좁힌 enum 밖의 값이 든 행이 있으면 DDL을 하나도 보내기 전에 던진다.
 * MySQL DDL은 암묵 커밋이라 마이그레이션 트랜잭션이 되돌리지 못한다 — 둘째 ALTER가 실패하면 첫째 ALTER만 반영된 채 마이그레이션은 "적용됨"으로 남았다.
 */
describe('enum을 좁히는 마이그레이션 down의 사전 검사', () => {
  /** count 쿼리마다 정해 둔 행 수를 돌려주는 가짜 드라이버 */
  const migration = <T>(Ctor: new (driver: never, config: never) => T, counts: number[]) => {
    const sqls: string[] = [];
    const driver = {
      execute: async (sql: string) => {
        sqls.push(sql);
        return [{ c: counts.shift() ?? 0 }];
      },
    };
    return { m: new Ctor(driver as never, {} as never), sqls };
  };

  it('Migration20261023015811: 새 출처 이력이 있으면 어떤 ALTER도 쌓기 전에 이유(표·열·행 수)를 담아 던진다', async () => {
    const { m } = migration(Migration20261023015811, [0, 3]);
    await expect(m.down()).rejects.toThrow(/terminal_status_history\.source.*3행/);
    expect(m.getQueries()).toEqual([]);
  });

  it('Migration20261023015811: SUPERSEDED 운송장만 있어도 던진다', async () => {
    const { m } = migration(Migration20261023015811, [2, 0]);
    await expect(m.down()).rejects.toThrow(/shipment\.status.*2행/);
    expect(m.getQueries()).toEqual([]);
  });

  it('Migration20261023015811: 좁힌 enum 밖 행이 없으면 ALTER 두 개를 쌓는다', async () => {
    const { m, sqls } = migration(Migration20261023015811, [0, 0]);
    await m.down();
    expect(sqls.join('\n')).toMatch(/not in \('IN_TRANSIT', ?'DELIVERED'\)/);
    expect(m.getQueries()).toHaveLength(2);
  });

  it('Migration20261022053251: BATCH 이력이 있으면 던진다', async () => {
    const { m } = migration(Migration20261022053251, [1]);
    await expect(m.down()).rejects.toThrow(/terminal_status_history\.source.*1행/);
    expect(m.getQueries()).toEqual([]);
  });
});
