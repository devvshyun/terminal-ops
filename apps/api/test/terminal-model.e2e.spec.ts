import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TerminalModel } from '../src/terminal/terminal-model.entity.js';
import { seedReference } from '../src/db/seed-reference.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('기준 데이터: 단말기 모델', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('SN-100/200/300 세 모델이 들어가고, SN-200만 재검수 필수다', async () => {
    const models = await t.orm.em.fork().find(TerminalModel, {}, { orderBy: { code: 'asc' } });
    expect(models.map((m) => [m.code, m.requiresReinspection])).toEqual([
      ['SN-100', false],
      ['SN-200', true],
      ['SN-300', false],
    ]);
  });

  it('시드를 두 번 돌려도 중복되지 않는다', async () => {
    await seedReference(t.orm.em.fork());
    expect(await t.orm.em.fork().count(TerminalModel)).toBe(3);
  });
});
