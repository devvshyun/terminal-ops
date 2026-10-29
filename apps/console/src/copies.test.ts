import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * 점주 앱에서 옮겨 온 사본(decisions/0062, 네 번째 앱도 같은 방식 — decisions/0075). 주석은 앱마다 다르게 쓰되 코드는 같아야 한다 — 한쪽만 고치면 여기서 실패한다.
 * 사본의 동작 테스트(api 클라이언트·KST 형식 등)는 점주 앱에 한 벌만 있다. 이 테스트가 "코드가 같다"를 지켜 그 테스트가 이 앱에도 맞게 한다.
 * 이 파일 자체는 현장 앱 `apps/field/src/copies.test.ts`를 옮긴 것이다(비교할 앱 이름 'console'과 주석만 다르다).
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
  'main.tsx',
];

/**
 * 주석·공백·줄바꿈(CRLF 포함)을 뺀 코드 = TypeScript 파서가 읽은 토큰을 차례로 한 줄에 하나씩(리뷰 반영).
 * 처음에는 정규식으로 주석을 지웠는데, 문자열·템플릿·정규식 리터럴 안의 `//`·`/* *\/`까지 지워 그 뒤의 차이를 놓쳤다.
 * `ts.createScanner`만 쓰면 정규식(`/a\/\/x/`)·템플릿(`${a}// x`) 문맥을 몰라 같은 일이 생긴다(직접 돌려 봄) — 문맥은 파서가 안다.
 * 그래서 파일을 파싱해 구문 트리의 잎(토큰)만 모은다. 주석은 토큰 사이의 trivia라 잎에 없다.
 * JSX 글자는 React가 JSX 글자를 다루는 규칙(줄마다 앞뒤 공백을 지우고 빈 줄을 버리고 줄을 한 칸으로 잇는다)으로 정리해 비교한다 —
 * (getText는 앞쪽 공백을 건너뛰어 `{a} {b}`의 공백이 사라지므로 node.text를 쓴다.) 줄바꿈이 든 공백뿐인 글자는 이 규칙에서 빈 문자열이 돼 저절로 빠지고, `{a} {b}`의 같은 줄 공백은 한 칸으로 남는다(리뷰 반영). `containsOnlyTriviaWhiteSpaces`는 같은 줄 공백도 true라 쓰지 않는다(직접 돌려 봄).
 * ScriptKind는 확장자를 따른다 — `.ts`를 TSX로 읽으면 `<string>x` 단언이 JSX로 읽힌다.
 * 한계: 토큰만 비교하므로 줄바꿈이 의미를 바꾸는 곳(ASI — `return` 뒤 줄바꿈 등)에서 줄을 나누기만 한 차이는 못 잡는다(decisions/0062).
 */
export function jsxTextValue(text: string): string {
  const lines = text.split(/\r\n|\n|\r/);
  const last = lines.length - 1;
  return lines
    .map((line, i) => {
      let l = line.replace(/\t/g, ' ');
      if (i !== 0) l = l.replace(/^ +/, '');
      if (i !== last) l = l.replace(/ +$/, '');
      return l;
    })
    .filter((l) => l !== '')
    .join(' ');
}

export function codeOnly(text: string, fileName = 'copy.tsx'): string {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const tokens: string[] = [];
  const visit = (node: ts.Node) => {
    // `/** … */`는 파서가 JSDoc 노드로 붙여 둔다(getChildren에 나온다) — 주석이라 뺀다
    const children = node.getChildren(file).filter((child) => !ts.isJSDoc(child));
    if (children.length > 0) return children.forEach(visit);
    const token = ts.isJsxText(node) ? jsxTextValue(node.text) : node.getText(file);
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
const read = (app: 'console' | 'merchant', path: string) => readFileSync(resolve(APPS, app, 'src', path), 'utf8');

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

  it('JSX 글자는 React 규칙으로 비교한다 — 줄바꿈·들여쓰기 차이는 같고, 같은 줄의 의미 있는 공백은 다르다(리뷰 반영)', () => {
    expect(codeOnly('const e = <p>\n  안녕   하세요\n  반갑습니다\n</p>;')).toBe(codeOnly('const e = <p>안녕   하세요 반갑습니다</p>;'));
    expect(codeOnly('const e = <p>{a} {b}</p>;')).not.toBe(codeOnly('const e = <p>{a}{b}</p>;'));
    expect(codeOnly('const e = <p>{a}\n  {b}</p>;')).toBe(codeOnly('const e = <p>{a}{b}</p>;'));
    expect(codeOnly('const e = <p>가 나</p>;')).not.toBe(codeOnly('const e = <p>가나</p>;'));
  });

  it('확장자를 따라 .ts는 TS로 읽는다(<T> 단언이 JSX로 읽히지 않는다)', () => {
    expect(codeOnly('const a = <string>b;', 'x.ts')).toBe('const\na\n=\n<\nstring\n>\nb\n;');
    expect(codeOnly('const a = <string>b;', 'x.ts')).not.toBe(codeOnly('const a = <string>c;', 'x.ts'));
  });

  it('머리 주석에 "의 사본(decisions/0062)"이라 적은 관제 파일은 모두 COPIES에 있다(목록에서 빠진 사본 방지)', () => {
    const sources = import.meta.glob(['./**/*.ts', './**/*.tsx', '!./**/*.test.ts', '!./**/*.test.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(10); // glob이 실제로 소스를 읽었는지
    const declared = files.filter((f) => sources[f].includes('의 사본(decisions/0062)')).map((f) => f.replace(/^\.\//, ''));
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((f) => !COPIES.includes(f))).toEqual([]);
  });

  it.each(COPIES)('%s는 점주 앱 것과 코드가 같다', (path) => {
    expect(codeOnly(read('console', path), path)).toBe(codeOnly(read('merchant', path), path));
  });
});
