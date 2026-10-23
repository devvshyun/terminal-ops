import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { readImportRows } from '../../src/terminal/terminal-import.service.js';

describe('readImportRows — 셀 형식별 (파일을 만들어 읽는다)', () => {
  it('글자 셀·숫자 셀·수식 결과는 값으로, 날짜·오류·불리언·큰 정수·0 채움 서식은 invalid로 표시한다', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('terminals');
    ws.addRow(['serialNo', 'modelCode']);
    const put = (row: number, serial: ExcelJS.CellValue, numFmt?: string) => {
      const cell = ws.getCell(`A${row}`);
      cell.value = serial;
      if (numFmt) cell.numFmt = numFmt;
      ws.getCell(`B${row}`).value = 'SN-100';
    };
    put(2, 'XL-T001');
    put(3, { richText: [{ text: 'XL-' }, { text: 'R001' }] });
    put(4, { text: 'XL-H001', hyperlink: 'http://example.invalid' });
    put(5, { formula: '"XL-F001"', result: 'XL-F001' });
    put(6, { formula: '10000-10000', result: 0 });
    put(7, 20261023);
    put(8, 123, '00000');
    put(9, new Date(Date.UTC(2026, 9, 23)));
    put(10, { error: '#N/A' });
    put(11, true);
    put(12, 12345678901234567890);
    put(13, { formula: 'C1' });
    const rows = await readImportRows(Buffer.from(await wb.xlsx.writeBuffer()));

    const view = rows.map((r) => [r.row, r.serialNo, r.invalid ? 'INVALID' : 'OK']);
    expect(view).toEqual([
      [2, 'XL-T001', 'OK'],
      [3, 'XL-R001', 'OK'],
      [4, 'XL-H001', 'OK'],
      [5, 'XL-F001', 'OK'],
      [6, '0', 'OK'], // cell.text였다면 '' (exceljs value 게터가 결과 0을 버린다)
      [7, '20261023', 'OK'],
      [8, '123', 'INVALID'], // cell.text였다면 '123'이 그대로 들어간다(00123이 아님)
      [9, '2026-10-23T00:00:00.000Z', 'INVALID'],
      [10, '#N/A', 'INVALID'],
      [11, 'true', 'INVALID'],
      [12, '12345678901234567000', 'INVALID'],
      [13, '=C1', 'INVALID'],
    ]);
    expect(rows.find((r) => r.row === 8)?.invalid).toContain('serialNo');
    expect(rows.every((r) => r.modelCode === 'SN-100')).toBe(true);
  });
});
