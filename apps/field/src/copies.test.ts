import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
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

/**
 * 주석·공백·줄바꿈(CRLF 포함)을 뺀 코드 = TypeScript 파서가 읽은 토큰을 차례로 한 줄에 하나씩(리뷰 반영).
 * 처음에는 정규식으로 주석을 지웠는데, 문자열·템플릿·정규식 리터럴 안의 `//`·`/* *\/`까지 지워 그 뒤의 차이를 놓쳤다.
 * `ts.createScanner`만 쓰면 정규식(`/a\/\/x/`)·템플릿(`${a}// x`) 문맥을 몰라 같은 일이 생긴다(직접 돌려 봄) — 문맥은 파서가 안다.
 * 그래서 파일을 파싱해 구문 트리의 잎(토큰)만 모은다. 주석은 토큰 사이의 trivia라 잎에 없다. JSX 글자는 공백을 한 칸으로 줄여 비교한다.
 */
export function codeOnly(text: string): string {
  const file = ts.createSourceFile('copy.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const tokens: string[] = [];
  const visit = (node: ts.Node) => {
    // `/** … */`는 파서가 JSDoc 노드로 붙여 둔다(getChildren에 나온다) — 주석이라 뺀다
    const children = node.getChildren(file).filter((child) => !ts.isJSDoc(child));
    if (children.length > 0) return children.forEach(visit);
    const token = ts.isJsxText(node) ? node.getText(file).replace(/\s+/g, ' ').trim() : node.getText(file);
    if (token !== '') tokens.push(token);
  };
  visit(file);
  return tokens.join('\n');
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
    expect(codeOnly(a)).toBe(codeOnly('const x = 1;\nconst url = "http://a";'));
    expect(codeOnly('const x = 2;\nconst url = "http://a";')).not.toBe(codeOnly(a));
  });

  it('codeOnly는 문자열·템플릿·정규식 리터럴 안의 // 와 /* */ 를 주석으로 보지 않는다(리뷰 반영)', () => {
    expect(codeOnly('const s = "a // x";')).not.toBe(codeOnly('const s = "a // y";'));
    expect(codeOnly("const s = 'a /* x */ b';")).not.toBe(codeOnly("const s = 'a /* y */ b';"));
    expect(codeOnly('const t = `${a} // x`;')).not.toBe(codeOnly('const t = `${a} // y`;'));
    expect(codeOnly('const r = /a\\/\\/x/;')).not.toBe(codeOnly('const r = /a\\/\\/y/;'));
  });

  it.each(COPIES)('%s는 점주 앱 것과 코드가 같다', (path) => {
    expect(codeOnly(read('field', path))).toBe(codeOnly(read('merchant', path)));
  });
});
