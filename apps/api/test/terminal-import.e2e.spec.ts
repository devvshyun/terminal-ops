import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TerminalStatusHistory } from '../src/terminal/terminal-status-history.entity.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'oh' };

/** 첫 시트에 행들을 쓴 .xlsx 버퍼 */
async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('terminals');
  for (const row of rows) ws.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('엑셀 일괄 등록 (F1, decisions/0005·0022)', () => {
  let t: TestApp;
  const upload = (buffer: Buffer, name = 'terminals.xlsx') => t.http().post('/terminals/imports').set(OP).attach('file', buffer, name);

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await t.http().post('/terminals').set(OP).send({ serialNo: 'XL-EXIST', modelCode: 'SN-100' });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('행마다 엑셀 행 번호와 결과를 주고, 유효한 행만 IMPORT 출처로 등록한다', async () => {
    const file = await xlsx([
      ['serialNo', 'modelCode'],
      ['XL-0001', 'SN-100'],
      ['XL-EXIST', 'SN-100'],
      ['xl-bad', 'SN-100'],
      [],
      ['XL-0002', 'SN-999'],
      [' XL-0003 ', 'SN-200'],
      [20261023, 'SN-300'],
    ]);
    const res = await upload(file, '10월 입고.xlsx');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ total: 6, summary: { CREATED: 3, ALREADY_EXISTS: 1, INVALID_FORMAT: 1, UNKNOWN_MODEL: 1 } });
    // 빈 행(5행)은 건너뛰고, 앞뒤 공백은 지우고, 숫자 셀은 보이는 글자 그대로 쓴다.
    expect(res.body.results.map((r: { row: number; serialNo: string; result: string }) => [r.row, r.serialNo, r.result])).toEqual([
      [2, 'XL-0001', 'CREATED'],
      [3, 'XL-EXIST', 'ALREADY_EXISTS'],
      [4, 'xl-bad', 'INVALID_FORMAT'],
      [6, 'XL-0002', 'UNKNOWN_MODEL'],
      [7, 'XL-0003', 'CREATED'],
      [8, '20261023', 'CREATED'],
    ]);
    const [history] = await t.orm.em.fork().find(TerminalStatusHistory, { terminal: { serialNo: 'XL-0003' } });
    expect(history).toMatchObject({ source: 'IMPORT', actor: 'oh', reason: '엑셀 일괄 등록: 10월 입고.xlsx' });
  });

  it('열 순서가 달라도, 다른 열이 있어도 머리글 이름으로 찾는다', async () => {
    const res = await upload(await xlsx([['비고', 'modelCode', 'serialNo'], ['메모', 'SN-100', 'XL-0101']]));
    expect(res.status).toBe(201);
    expect(res.body.results).toEqual([{ row: 2, serialNo: 'XL-0101', result: 'CREATED' }]);
  });

  it('머리글에 serialNo·modelCode가 없으면 400 MISSING_COLUMNS', async () => {
    const res = await upload(await xlsx([['시리얼', '모델'], ['XL-0201', 'SN-100']]));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_COLUMNS');
  });

  it('xlsx가 아니면 400 INVALID_FILE, 파일이 없으면 400', async () => {
    const fake = await upload(Buffer.from('serialNo,modelCode\nXL-0301,SN-100\n'), 'terminals.xlsx');
    expect(fake.status).toBe(400);
    expect(fake.body.code).toBe('INVALID_FILE');
    const csv = await upload(await xlsx([['serialNo', 'modelCode']]), 'terminals.csv');
    expect(csv.status).toBe(400);
    expect(csv.body.code).toBe('INVALID_FILE');
    expect((await t.http().post('/terminals/imports').set(OP)).status).toBe(400);
  });

  it('데이터 행이 5000개를 넘으면 400 TOO_MANY_ROWS', async () => {
    const rows = [['serialNo', 'modelCode'], ...Array.from({ length: 5001 }, (_, i) => [`XL-M${String(i).padStart(5, '0')}`, 'SN-100'])];
    const res = await upload(await xlsx(rows));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TOO_MANY_ROWS');
  });

  it('2MB보다 큰 파일은 413 FILE_TOO_LARGE', async () => {
    const res = await upload(Buffer.alloc(2 * 1024 * 1024 + 1), 'big.xlsx');
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
  });

  it('file이 아닌 필드 이름, 파일 두 개, 글자 필드는 400 INVALID_FILE', async () => {
    const file = await xlsx([['serialNo', 'modelCode'], ['XL-0401', 'SN-100']]);
    const wrongField = await t.http().post('/terminals/imports').set(OP).attach('upload', file, 'terminals.xlsx');
    expect(wrongField.status).toBe(400);
    expect(wrongField.body.code).toBe('INVALID_FILE');
    const twoFiles = await t.http().post('/terminals/imports').set(OP).attach('file', file, 'a.xlsx').attach('file', file, 'b.xlsx');
    expect(twoFiles.status).toBe(400);
    expect(twoFiles.body.code).toBe('INVALID_FILE');
    const withField = await t.http().post('/terminals/imports').set(OP).field('note', 'x').attach('file', file, 'terminals.xlsx');
    expect(withField.status).toBe(400);
    expect(withField.body.code).toBe('INVALID_FILE');
    expect(await t.orm.em.fork().count(TerminalStatusHistory, { terminal: { serialNo: 'XL-0401' } })).toBe(0);
  });

  it('날짜·0 채움 서식 숫자 셀은 그 행만 INVALID_FORMAT(이유를 message에), 나머지는 등록한다', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('terminals');
    ws.addRow(['serialNo', 'modelCode']);
    ws.addRow([new Date(Date.UTC(2026, 9, 23)), 'SN-100']);
    ws.addRow([123, 'SN-100']);
    ws.getCell('A3').numFmt = '00000';
    ws.addRow(['XL-0501', 'SN-100']);
    ws.addRow([{ formula: '"XL-0502"', result: 'XL-0502' }, 'SN-100']);
    const res = await upload(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(res.status).toBe(201);
    expect(res.body.summary).toEqual({ INVALID_FORMAT: 2, CREATED: 2 });
    expect(res.body.results[0]).toMatchObject({ row: 2, result: 'INVALID_FORMAT', message: expect.stringContaining('날짜') });
    expect(res.body.results[1]).toMatchObject({ row: 3, serialNo: '123', result: 'INVALID_FORMAT', message: expect.stringContaining('텍스트 셀로 입력') });
    expect(res.body.results.slice(2)).toEqual([
      { row: 4, serialNo: 'XL-0501', result: 'CREATED' },
      { row: 5, serialNo: 'XL-0502', result: 'CREATED' },
    ]);
  });
});
