import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 점주 앱에서 옮겨 온 사본(decisions/0062). 주석은 앱마다 다르게 쓰되 코드는 같아야 한다 — 한쪽만 고치면 여기서 실패한다.
 * 사본의 동작 테스트(api 클라이언트·KST 형식 등)는 점주 앱에 한 벌만 있다. 이 테스트가 "코드가 같다"를 지켜 그 테스트가 이 앱에도 맞게 한다.
 */
const COPIES = [
  'api/client.ts',
  'session.ts',
  'query-client.ts',
  'lib/format.ts',
  'components/SessionCacheSync.tsx',
  'components/LogoutButton.tsx',
  'hooks/useSessionCheck.ts',
  'test/setup.ts',
];

/** 주석(블록 주석, 줄 전체 주석, 코드 뒤 ` // …`)·빈 줄·줄 끝 공백과 줄바꿈 차이(CRLF)를 뺀 코드 */
export function codeOnly(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, '').replace(/\s+\/\/ .*$/, '').trimEnd())
    .filter((line) => line.trim() !== '')
    .join('\n');
}

/**
 * apps 폴더. 다른 앱 파일 경로를 `new URL(템플릿 문자열, import.meta.url)`로 만들면 Vite가 그 모양을 자산 import(`?url` glob)로 바꿔
 * 다른 앱 파일까지 불러오려다 `Denied ID …?url`로 실패한다(사전 검증) — 경로는 node:path로 만든다.
 */
const APPS = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (app: 'field' | 'merchant', path: string) => readFileSync(resolve(APPS, app, 'src', path), 'utf8');

describe('점주 앱 사본 (decisions/0062)', () => {
  it('codeOnly는 주석만 빼고 코드 차이는 남긴다', () => {
    const a = '/** 머리 */\nconst x = 1; // 뒤 주석\n// 줄 주석\n\nconst url = "http://a";\r\n';
    expect(codeOnly(a)).toBe('const x = 1;\nconst url = "http://a";');
    expect(codeOnly('const x = 2;')).not.toBe(codeOnly(a).split('\n')[0]);
  });

  it.each(COPIES)('%s는 점주 앱 것과 코드가 같다', (path) => {
    expect(codeOnly(read('field', path))).toBe(codeOnly(read('merchant', path)));
  });
});
