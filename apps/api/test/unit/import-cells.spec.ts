import { describe, expect, it } from 'vitest';
import { readCellValue } from '../../src/terminal/import-cells.js';

/**
 * 엑셀 셀 값은 형식(type)별로 읽는다(cell.text 금지, decisions/0022).
 * cell.text는 숫자 서식(00000)을 무시하고, 날짜는 로컬 문자열, 결과가 0인 수식은 빈 글자, 큰 정수는 정밀도를 잃는다.
 */
describe('readCellValue', () => {
  it('문자열·리치 텍스트·하이퍼링크는 글자 그대로', () => {
    expect(readCellValue('XL-0001')).toEqual({ ok: true, text: 'XL-0001' });
    expect(readCellValue({ richText: [{ text: 'XL-' }, { text: 'R001' }] })).toEqual({ ok: true, text: 'XL-R001' });
    expect(readCellValue({ text: 'XL-H001', hyperlink: 'http://example.invalid' })).toEqual({ ok: true, text: 'XL-H001' });
  });

  it('빈 셀은 빈 글자', () => {
    expect(readCellValue(null)).toEqual({ ok: true, text: '' });
    expect(readCellValue(undefined)).toEqual({ ok: true, text: '' });
  });

  it('안전한 정수는 String(v), 결과가 0인 수식은 "0"', () => {
    expect(readCellValue(20261023)).toEqual({ ok: true, text: '20261023' });
    expect(readCellValue({ formula: '1-1', result: 0 })).toEqual({ ok: true, text: '0' });
    expect(readCellValue({ formula: '"XL-F001"', result: 'XL-F001' })).toEqual({ ok: true, text: 'XL-F001' });
  });

  it('큰 정수·소수는 정확히 못 읽으므로 거절한다', () => {
    const big = readCellValue(12345678901234567890);
    expect(big).toMatchObject({ ok: false, message: expect.stringContaining('텍스트 셀') });
    expect(readCellValue(12.5)).toMatchObject({ ok: false });
  });

  it('날짜·오류·불리언 셀, 결과 없는 수식은 거절한다', () => {
    expect(readCellValue(new Date(Date.UTC(2026, 9, 23)))).toMatchObject({ ok: false, message: expect.stringContaining('날짜') });
    expect(readCellValue({ error: '#N/A' })).toMatchObject({ ok: false, text: '#N/A', message: expect.stringContaining('오류') });
    expect(readCellValue(true)).toMatchObject({ ok: false, text: 'true', message: expect.stringContaining('불리언') });
    expect(readCellValue({ formula: 'B1' })).toMatchObject({ ok: false, message: expect.stringContaining('수식') });
    expect(readCellValue({ formula: 'B1', result: { error: '#REF!' } })).toMatchObject({ ok: false, message: expect.stringContaining('오류') });
  });

  it('앞자리 0을 채우는 숫자 서식(00000)의 숫자 셀은 거절한다(서식이 무시돼 0이 사라진다)', () => {
    expect(readCellValue(123, '00000')).toMatchObject({ ok: false, text: '123', message: expect.stringContaining('텍스트 셀로 입력') });
    expect(readCellValue(1234, '"SN"000000')).toMatchObject({ ok: false });
    expect(readCellValue({ formula: 'A5', result: 7 }, '00000')).toMatchObject({ ok: false });
    // 0 하나·천 단위 구분·소수 자리는 앞자리를 채우지 않는다
    expect(readCellValue(123, '0')).toEqual({ ok: true, text: '123' });
    expect(readCellValue(123, '#,##0')).toEqual({ ok: true, text: '123' });
    expect(readCellValue(123, '0.00')).toEqual({ ok: true, text: '123' });
    expect(readCellValue(123, 'General')).toEqual({ ok: true, text: '123' });
  });
});
