import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIFECYCLE, RECORD_TITLES, STATS, recordCounts } from './content';

/** 저장소 루트(apps/landing/src 기준 세 단계 위) */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');

describe('소개 페이지 내용은 기록과 같다(decisions/0078)', () => {
  it.each(STATS.map((s) => [s.title, s] as const))('숫자 "%s"의 근거 글이 출처 실험 기록에 그대로 있다', (_, stat) => {
    const text = read(stat.source);
    for (const quote of stat.quote) expect(text).toContain(quote);
  });

  it.each(RECORD_TITLES.map((r) => [r.title, r] as const))('기록 제목 "%s"가 그 파일 첫 줄과 같다', (_, record) => {
    const first = read(record.source).split(/\r?\n/)[0];
    expect(first).toMatch(/^# \d{4}\. /);
    expect(first.replace(/^# \d{4}\. /, '')).toBe(record.title);
  });

  it('기록 수는 docs 폴더의 파일 수다', () => {
    const counts = recordCounts();
    expect(counts.decisions).toBeGreaterThanOrEqual(70);
    expect(counts.troubleshooting).toBeGreaterThanOrEqual(32);
    expect(counts.experiments).toBeGreaterThanOrEqual(18);
  });

  it('생애주기 상태 코드는 api 상태 값이다', () => {
    const statuses = read('packages/contracts/src/statuses.ts');
    for (const stage of LIFECYCLE) expect(statuses).toContain(`'${stage.code}'`);
  });
});
