import { describe, expect, it } from 'vitest';
import { Migration20261026034551 } from '../../src/migrations/Migration20261026034551.js';

/**
 * 최종 리뷰 반영(Minor 3): status 인덱스를 바꾸는 마이그레이션은 up·down 모두 "새 인덱스를 먼저 만들고 옛 인덱스를 지운다".
 * 그 사이에 실패해도 status로 찾는 쿼리가 쓸 인덱스가 하나는 남는다(decisions/0034).
 */
describe('Migration20261026034551 status 인덱스 순서', () => {
  const queries = (dir: 'up' | 'down') => {
    const m = new Migration20261026034551({} as never, {} as never);
    void m[dir]();
    return m.getQueries().map(String);
  };
  const at = (qs: string[], re: RegExp) => qs.findIndex((q) => re.test(q));

  it('up: 복합 인덱스 추가 → status 단독 인덱스 삭제', () => {
    const qs = queries('up');
    expect(at(qs, /add index `terminal_status_status_changed_at_index`/)).toBeLessThan(at(qs, /drop index `terminal_status_index`/));
  });

  it('down: status 단독 인덱스 추가 → 복합 인덱스 삭제 → status_changed_at 열 삭제', () => {
    const qs = queries('down');
    const add = at(qs, /add index `terminal_status_index`/);
    const dropComposite = at(qs, /drop index `terminal_status_status_changed_at_index`/);
    const dropColumn = at(qs, /drop column `status_changed_at`/);
    expect([add, dropComposite, dropColumn].every((i) => i >= 0)).toBe(true);
    expect(add).toBeLessThan(dropComposite);
    expect(dropComposite).toBeLessThan(dropColumn);
  });
});
