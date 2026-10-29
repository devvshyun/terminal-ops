import { describe, expect, it } from 'vitest';
import { csvBlob, csvCell, toCsv } from './csv';

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
    expect(csvCell('\t=1+1')).toBe("'\t=1+1");
    expect(csvCell('\r=1')).toBe('"\'\r=1"');
  });

  it('내려받기 Blob은 BOM을 붙인 UTF-8 text/csv', async () => {
    const blob = csvBlob('가,나');
    expect(blob.type).toBe('text/csv;charset=utf-8');
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(new Uint8Array(await blob.arrayBuffer()).slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf])); // UTF-8 BOM
    expect(text.replace(/^﻿/, '')).toBe('가,나');
  });
});
