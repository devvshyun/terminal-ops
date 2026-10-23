import { describe, expect, it } from 'vitest';
import { normalizeRows, precheckSerials, summarize } from '../../src/terminal/bulk-rows.js';

describe('precheckSerials', () => {
  it('통과한 행은 null, 결과는 입력 순서 그대로', () => {
    expect(precheckSerials(['A-0001', 'A-0002'])).toEqual([null, null]);
  });

  it('형식이 틀리면 INVALID_FORMAT', () => {
    const [lower, short, space] = precheckSerials(['a-0001', 'AB', 'A 0001']);
    expect(lower?.result).toBe('INVALID_FORMAT');
    expect(short?.result).toBe('INVALID_FORMAT');
    expect(space?.result).toBe('INVALID_FORMAT');
  });

  it('같은 요청에 같은 시리얼이 또 나오면 두 번째부터 DUPLICATE_IN_REQUEST', () => {
    const r = precheckSerials(['A-0001', 'A-0002', 'A-0001', 'A-0001']);
    expect(r.map((x) => x?.result ?? null)).toEqual([null, null, 'DUPLICATE_IN_REQUEST', 'DUPLICATE_IN_REQUEST']);
  });

  it('형식이 틀린 행은 중복 판단에 쓰지 않는다', () => {
    expect(precheckSerials(['bad', 'bad']).map((x) => x?.result)).toEqual(['INVALID_FORMAT', 'INVALID_FORMAT']);
  });
});

describe('summarize', () => {
  it('결과 코드별로 센다', () => {
    expect(
      summarize([
        { serialNo: 'A', result: 'CREATED' },
        { serialNo: 'B', result: 'CREATED' },
        { serialNo: 'C', result: 'ALREADY_EXISTS' },
      ]),
    ).toEqual({ CREATED: 2, ALREADY_EXISTS: 1 });
  });
});

describe('normalizeRows', () => {
  it('문자열이 아닌 값은 문자열로, 앞뒤 공백은 지운다. 없는 값은 빈 문자열', () => {
    const rows = normalizeRows([
      { serialNo: 12345678, modelCode: ' SN-100 ' },
      { serialNo: '  A-0001 ', modelCode: undefined },
      { serialNo: null, modelCode: 'SN-100' },
    ]);
    expect(rows).toEqual([
      { serialNo: '12345678', modelCode: 'SN-100' },
      { serialNo: 'A-0001', modelCode: '' },
      { serialNo: '', modelCode: 'SN-100' },
    ]);
  });

  it('숫자 12345678과 문자열 "12345678"은 같은 시리얼이다: 두 번째가 DUPLICATE_IN_REQUEST', () => {
    const rows = normalizeRows([
      { serialNo: 12345678, modelCode: 'SN-100' },
      { serialNo: '12345678', modelCode: 'SN-100' },
      { serialNo: undefined, modelCode: 'SN-100' },
    ]);
    expect(precheckSerials(rows.map((r) => r.serialNo)).map((r) => r?.result ?? null)).toEqual([null, 'DUPLICATE_IN_REQUEST', 'INVALID_FORMAT']);
  });
});
