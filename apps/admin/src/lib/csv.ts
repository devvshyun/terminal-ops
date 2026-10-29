import type { TerminalImportView } from '@terminal-ops/contracts';
import { ROW_RESULT_LABEL } from './labels';

/** CSV 칸 하나: 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감싸고 안의 따옴표는 두 번(RFC 4180). 엑셀이 수식으로 읽는 머리 글자(= + - @, 탭·CR로 시작하는 칸도)는 앞에 '를 붙인다 */
export function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: (string | number)[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/** 엑셀 일괄 등록 결과를 CSV로(행·시리얼·결과 코드·결과·이유). 화면이 내려받기 링크로 준다(보강 5) */
export function importResultCsv(view: TerminalImportView): string {
  return toCsv([
    ['row', 'serialNo', 'result', '결과', '이유'],
    ...view.results.map((r) => [r.row, r.serialNo, r.result, ROW_RESULT_LABEL[r.result] ?? r.result, r.message ?? '']),
  ]);
}

/** 내려받기용 Blob. 앞에 BOM을 붙여 엑셀이 UTF-8 한글을 바로 읽게 한다 */
export function csvBlob(csv: string): Blob {
  return new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
}

/**
 * 클릭할 때 Blob URL을 만들어 내려받고 바로 해제한다(렌더마다 인코딩하지 않는다, 5,000행 CSV도 data: URL 길이 상한에 걸리지 않는다 — decisions/0068)
 */
export function downloadCsv(csv: string, fileName: string): void {
  const url = URL.createObjectURL(csvBlob(csv));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
