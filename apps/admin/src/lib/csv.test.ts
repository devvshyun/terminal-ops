import { describe, expect, it } from 'vitest';
import { csvCell, csvDataUrl, toCsv } from './csv';

describe('CSV (보강 5 엑셀 등록 결과 내려받기)', () => {
  it('쉼표·따옴표·줄바꿈이 있는 칸만 따옴표로 감싸고, 안의 따옴표는 두 번', () => {
    expect(csvCell('SN-0001')).toBe('SN-0001');
    expect(csvCell(12)).toBe('12');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('그는 "예"라고')).toBe('"그는 ""예""라고"');
    expect(csvCell('줄\n바꿈')).toBe('"줄\n바꿈"');
    expect(toCsv([['a', 1], ['b,c', 2]])).toBe('a,1\r\n"b,c",2');
  });

  it('엑셀이 수식으로 읽는 머리 글자(= + - @)는 앞에 작은따옴표를 붙인다', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@a')).toBe("'@a");
  });

  it('내려받기 주소는 BOM을 붙인 UTF-8 data URL', () => {
    expect(decodeURIComponent(csvDataUrl('가,나').replace('data:text/csv;charset=utf-8,', ''))).toBe('﻿가,나');
  });
});
