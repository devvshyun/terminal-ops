import { describe, expect, it } from 'vitest';
import { keys } from './query-keys';

/** 화면·컴포넌트 소스(테스트 제외). 키 글자를 직접 쓰는 곳이 없는지 본다 — 어드민 `api/query-keys.test.ts`를 옮겨 온 것(decisions/0058) */
const sources = import.meta.glob(['../**/*.tsx', '../**/*.ts', '!../**/*.test.tsx', '!../**/*.test.ts', '!./query-keys.ts', '!../test/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('쿼리 키 팩토리', () => {
  it('모든 키가 keys.all로 시작한다(쓰기 뒤 keys.all 무효화가 닿는다)', () => {
    const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) => prefix.every((p, i) => key[i] === p);
    for (const key of [keys.merchant, keys.terminals, keys.terminal('SN-1'), keys.tickets(), keys.tickets('SN-1'), keys.ticket(7)]) {
      expect(startsWith(key, keys.all)).toBe(true);
    }
  });

  it('화면·컴포넌트는 키 글자를 직접 쓰지 않고 이 파일의 keys만 쓴다', () => {
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(15); // glob이 실제로 소스를 읽었는지
    const offenders = files.filter((f) => /queryKey:\s*\[/.test(sources[f]));
    expect(offenders).toEqual([]);
  });
});
