import { describe, expect, it } from 'vitest';
import { keys } from './query-keys';

/** 화면·컴포넌트 소스(테스트 제외). 키 글자를 직접 쓰는 곳이 없는지 본다 — 점주 앱 `api/query-keys.test.ts`와 같은 검사(decisions/0058) */
const sources = import.meta.glob(['../**/*.tsx', '../**/*.ts', '!../**/*.test.tsx', '!../**/*.test.ts', '!./query-keys.ts', '!../test/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('쿼리 키 팩토리', () => {
  it('모든 키가 keys.all로 시작하고, 업체별 키 목록은 keys.keysAll, 호출 로그는 keys.callsAll로 시작한다', () => {
    const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) => prefix.every((p, i) => key[i] === p);
    for (const key of [keys.partners, keys.keysAll, keys.keys(1), keys.callsAll, keys.calls({}), keys.docs]) {
      expect(startsWith(key, keys.all)).toBe(true);
    }
    expect(startsWith(keys.keys(3), keys.keysAll)).toBe(true);
    expect(startsWith(keys.calls({ partnerId: 3, limit: 20 }), keys.callsAll)).toBe(true);
  });

  it('화면·컴포넌트는 키 글자를 직접 쓰지 않고 이 파일의 keys만 쓴다', () => {
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(8); // glob이 실제로 소스를 읽었는지
    const offenders = files.filter((f) => /queryKey:\s*\[/.test(sources[f]));
    expect(offenders).toEqual([]);
  });
});
