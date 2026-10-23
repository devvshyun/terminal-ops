import { BadRequestException, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { BulkRegistrationService, type BulkRegisterRow } from './bulk-registration.service.js';
import { summarize, type RowResult } from './bulk-rows.js';
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
}

function invalid(code: string, message: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, code, message });
}

/**
 * .xlsx 첫 시트를 읽는다. 1행은 머리글이고 serialNo·modelCode 열을 이름으로 찾는다(순서·다른 열 무관).
 * 빈 행은 건너뛰고, 셀은 보이는 글자(cell.text)를 앞뒤 공백 없이 쓴다 — 숫자로 저장된 시리얼도 글자 그대로 받는다.
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
    const serialNo = row.getCell(serialCol).text.trim();
    const modelCode = row.getCell(modelCol).text.trim();
    if (!serialNo && !modelCode) return;
    rows.push({ row: rowNumber, serialNo, modelCode });
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
    const results = await this.bulk.register(rows, {
      actor,
      source: TransitionSource.IMPORT,
      reason: `엑셀 일괄 등록: ${file.originalname}`.slice(0, 200),
    });
    return {
      fileName: file.originalname,
      total: rows.length,
      summary: summarize(results),
      results: results.map((r: RowResult, i) => ({ row: rows[i].row, ...r })),
    };
  }
}
