import { BadRequestException, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { BulkRegistrationService, type BulkRegisterRow } from './bulk-registration.service.js';
import { summarize, type RowResult } from './bulk-rows.js';
import { readCellValue } from './import-cells.js';
import { TransitionSource } from './terminal-status.js';

/** 한 파일에서 받는 데이터 행 수 상한 */
export const MAX_IMPORT_ROWS = 5000;

/** multer 메모리 저장소가 주는 파일(필요한 필드만) */
export interface UploadedSpreadsheet {
  originalname: string;
  size: number;
  buffer: Buffer;
}

export interface ImportRow extends BulkRegisterRow {
  /** 엑셀 행 번호(머리글이 1행) */
  row: number;
  /** 셀을 정확히 읽을 수 없으면 그 이유. 이 행은 엔진에 넘기지 않고 INVALID_FORMAT으로 끝난다. */
  invalid?: string;
}

/** 셀 하나를 형식별로 읽는다. 수식은 cell.result로 결과를 넘긴다(cell.value 게터는 결과 0을 버린다). */
function readCell(cell: ExcelJS.Cell) {
  const value = cell.type === ExcelJS.ValueType.Formula ? { formula: cell.formula, result: cell.result } : cell.value;
  return readCellValue(value, cell.numFmt);
}

function invalid(code: string, message: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, code, message });
}

/**
 * .xlsx 첫 시트를 읽는다. 1행은 머리글이고 serialNo·modelCode 열을 이름으로 찾는다(순서·다른 열 무관).
 * 빈 행은 건너뛰고, 셀은 형식별로 읽어(readCellValue) 앞뒤 공백을 지운다. 글자·리치 텍스트·하이퍼링크·수식 결과·안전한 정수는 값으로,
 * 날짜·오류·불리언·큰 정수·소수·0 채움 서식 숫자·결과 없는 수식은 invalid로 표시한다(decisions/0022).
 */
export async function readImportRows(buffer: Buffer): Promise<ImportRow[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs 4.4.0 타입은 load 인자를 ArrayBuffer 계열(자체 Buffer 선언)로 적어 Node Buffer(Uint8Array)와 타입이 맞지 않는다.
    // 실행에서는 Node Buffer를 그대로 읽는다(사전 검증). 타입만 맞춘다.
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw invalid('INVALID_FILE', '.xlsx 파일을 읽을 수 없습니다.');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw invalid('INVALID_FILE', '시트가 없습니다.');

  const header = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, col) => header.set(cell.text.trim(), col));
  const serialCol = header.get('serialNo');
  const modelCol = header.get('modelCode');
  if (!serialCol || !modelCol) throw invalid('MISSING_COLUMNS', '1행 머리글에 serialNo, modelCode 열이 있어야 합니다.');

  const rows: ImportRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const serial = readCell(row.getCell(serialCol));
    const model = readCell(row.getCell(modelCol));
    const serialNo = serial.text.trim();
    const modelCode = model.text.trim();
    if (!serialNo && !modelCode) return;
    const problems = [serial.ok ? null : `serialNo: ${serial.message}`, model.ok ? null : `modelCode: ${model.message}`].filter(Boolean);
    rows.push(problems.length ? { row: rowNumber, serialNo, modelCode, invalid: problems.join(' / ') } : { row: rowNumber, serialNo, modelCode });
  });
  if (rows.length > MAX_IMPORT_ROWS) throw invalid('TOO_MANY_ROWS', `데이터 행은 ${MAX_IMPORT_ROWS}개까지 받습니다(받은 행: ${rows.length}).`);
  return rows;
}

/** 엑셀 일괄 등록(F1, decisions/0005·0022). 박스 스캔과 같은 일괄 등록 엔진을 쓴다(source IMPORT). */
@Injectable()
export class TerminalImportService {
  constructor(private readonly bulk: BulkRegistrationService) {}

  async import(file: UploadedSpreadsheet | undefined, actor: string) {
    if (!file) throw invalid('INVALID_FILE', 'file 필드로 .xlsx 파일을 보내세요.');
    if (!file.originalname.toLowerCase().endsWith('.xlsx')) throw invalid('INVALID_FILE', '.xlsx 파일만 받습니다.');
    const rows = await readImportRows(file.buffer);
    // 셀을 정확히 읽지 못한 행은 엔진에 넘기지 않는다(그 행은 INVALID_FORMAT). 엔진에서도 형식이 틀린 행은 중복 판단에 들어가지 않으므로 결과가 같다.
    const readable = rows.filter((r) => !r.invalid);
    const registered = readable.length
      ? await this.bulk.register(readable, {
          actor,
          source: TransitionSource.IMPORT,
          reason: `엑셀 일괄 등록: ${file.originalname}`.slice(0, 200),
        })
      : [];
    let next = 0;
    const results: RowResult[] = rows.map((r) =>
      r.invalid ? { serialNo: r.serialNo, result: 'INVALID_FORMAT', message: r.invalid } : registered[next++],
    );
    return {
      fileName: file.originalname,
      total: rows.length,
      summary: summarize(results),
      results: results.map((r, i) => ({ row: rows[i].row, ...r })),
    };
  }
}
