import { resolve } from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * contracts와 api가 어긋나면 api tsc가 실패하는지(decisions/0048). contracts 파일 하나의 글자를 메모리에서만 바꿔
 * TypeScript 컴파일러 API로 api 일부를 검사한다 — 디스크의 파일은 건드리지 않는다.
 * vitest(swc)는 타입을 검사하지 않으므로 이 테스트가 "타입 단언이 실제로 tsc를 멈추게 한다"는 것을 테스트 실행에서 보여 준다.
 */
const API = resolve(import.meta.dirname, '../..');
const CONTRACTS = resolve(API, '../../packages/contracts/src');
/** 검사 대상 api 파일(이 파일들이 import하는 것도 함께 검사된다) */
const ROOTS = ['src/common/contract-assertions.ts', 'src/scan/scan.service.ts', 'src/terminal/terminal.views.ts', 'src/service/dto/service-ticket.dto.ts'].map((f) =>
  resolve(API, f),
);

const norm = (p: string) => p.replaceAll('\\', '/').toLowerCase();

function loadOptions(): ts.CompilerOptions {
  const file = resolve(API, 'tsconfig.json');
  const config = ts.readConfigFile(file, (p) => ts.sys.readFile(p));
  return { ...ts.parseJsonConfigFileContent(config.config, ts.sys, API).options, noEmit: true };
}

let options: ts.CompilerOptions;
let base: ts.Program;

/** contracts의 파일 하나(src 아래 이름)를 edit으로 바꾼 채 검사하고, 오류를 "파일:코드 메시지" 줄로 돌려준다 */
function diagnosticsWith(file: string, edit: (text: string) => string): string[] {
  const target = norm(resolve(CONTRACTS, file));
  const host = ts.createCompilerHost(options, true);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
    if (norm(name) !== target) return original(name, languageVersion, onError, shouldCreate);
    const text = ts.sys.readFile(name)!;
    const changed = edit(text);
    if (changed === text) throw new Error(`${file}: 바꿀 글자를 찾지 못했다`);
    return ts.createSourceFile(name, changed, languageVersion);
  };
  const program = ts.createProgram({ rootNames: ROOTS, options, host, oldProgram: base });
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file ? norm(d.file.fileName).replace(norm(API) + '/', '') : '-';
    return `${where}:TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
  });
}

describe('contracts가 바뀌면 api tsc가 실패한다 (decisions/0048)', () => {
  beforeAll(() => {
    options = loadOptions();
    base = ts.createProgram({ rootNames: ROOTS, options });
  });

  it('그대로면 오류가 없다', () => {
    expect(ts.getPreEmitDiagnostics(base).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))).toEqual([]);
  });

  it('상태 값을 contracts에서 빼면 api enum과 다르다고 실패한다(빠진 값이 메시지에)', () => {
    const errors = diagnosticsWith('statuses.ts', (t) => t.replace("  | 'DISPOSED';", ';'));
    // 그 상태를 응답에 넣는 view 함수들도 함께 실패한다(Task 2부터) — 빠진 값을 이름으로 알려 주는 것은 단언 파일
    expect(errors).toContainEqual(expect.stringMatching(/^src\/common\/contract-assertions\.ts:TS2344 .*onlyInApi: "DISPOSED"/));
  });

  it('contracts에만 상태 값을 더해도 실패한다', () => {
    const errors = diagnosticsWith('statuses.ts', (t) => t.replace("export type ScanKind = 'RECEIVE' | 'RETURN_IN';", "export type ScanKind = 'RECEIVE' | 'RETURN_IN' | 'REPAIR_IN';"));
    expect(errors).toEqual([expect.stringMatching(/^src\/common\/contract-assertions\.ts:TS2344 .*onlyInContract: "REPAIR_IN"/)]);
  });

  it('오류 코드를 contracts에서 빼면 그 코드를 던지는 곳이 실패한다', () => {
    const errors = diagnosticsWith('errors.ts', (t) => t.replace(/ {2}\| 'PO_CLOSED'\r?\n/, '')); // 체크아웃 줄바꿈(CRLF·LF) 어느 쪽이든
    expect(errors).toEqual([expect.stringMatching(/^src\/scan\/scan\.service\.ts:TS2769 No overload matches this call/)]);
  });

  it('응답 필드 이름을 contracts에서 바꾸면 그 응답을 만드는 view 함수가 실패한다', () => {
    const errors = diagnosticsWith('terminal.ts', (t) => t.replace('  serialNo: string;', '  serialNumber: string;')); // 첫 번째 = TerminalView
    expect(errors).toEqual([expect.stringMatching(/^src\/terminal\/terminal\.views\.ts:TS2353 .*'serialNo' does not exist in type 'TerminalView'/)]);
  });

  it('contracts에 응답 필드를 더하고 api가 채우지 않으면 실패한다', () => {
    const errors = diagnosticsWith('terminal.ts', (t) => t.replace('  merchantCode: string | null;', '  merchantCode: string | null;\n  installedAt: string | null;'));
    expect(errors).toEqual([expect.stringMatching(/^src\/terminal\/terminal\.views\.ts:TS2741 Property 'installedAt' is missing/)]);
  });

  it('요청 본문 필드를 contracts에서 바꾸면 그 모양을 implements한 DTO가 실패한다', () => {
    const errors = diagnosticsWith('requests.ts', (t) => t.replace('  symptom: string;', '  description: string;'));
    expect(errors).toEqual([expect.stringMatching(/^src\/service\/dto\/service-ticket\.dto\.ts:TS2420 Class 'OpenTicketDto' incorrectly implements interface 'OpenTicketRequest'/)]);
  });
});
