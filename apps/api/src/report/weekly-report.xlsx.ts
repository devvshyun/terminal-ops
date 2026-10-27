import ExcelJS from 'exceljs';
import { ANOMALY_RULE_LABEL } from '../anomaly/anomaly-labels.js';
import type { AnomalyRule } from '../anomaly/anomaly.entity.js';
import { KIND_LABEL } from '../van/van-labels.js';
import type { VanMismatchKind } from '../van/van.entities.js';
import { kstDate } from './kst-week.js';
import type { WeeklyReportData } from './weekly-report.queries.js';

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 시트 이름(순서대로). 엑셀 시트 이름에는 : \ / ? * [ ]를 쓸 수 없고 31자까지다 */
export const SHEET_NAMES = ['요약', '상태·모델', '전이', '입출고', '이상 단말기', '접속 상태', '펌웨어 배포', 'VAN 대조'] as const;

export function weeklyReportFileName(weekStart: string): string {
  return `단말온-주간리포트-${weekStart}.xlsx`;
}

/** ISO 시각 → 'YYYY-MM-DD HH:mm' (KST) */
function kst(isoText: string | null): string {
  if (!isoText) return '';
  const k = new Date(new Date(isoText).getTime() + 9 * 3_600_000);
  return k.toISOString().slice(0, 16).replace('T', ' ');
}

/** 시트 첫 줄 안내(기울임). 표 머리글은 그다음 줄이 된다 */
function note(sheet: ExcelJS.Worksheet, text: string): void {
  sheet.addRow([text]).font = { italic: true };
}

/** 머리글(굵게)과 행을 넣고 열 너비를 글자 수에 맞춘다 */
function table(sheet: ExcelJS.Worksheet, header: string[], rows: (string | number)[][]): void {
  sheet.addRow(header).font = { bold: true };
  for (const r of rows) sheet.addRow(r);
  header.forEach((h, i) => {
    const longest = Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length));
    sheet.getColumn(i + 1).width = Math.min(60, Math.max(10, longest + 4));
  });
}

/**
 * 주간 리포트 xlsx(F11). 데이터는 WeeklyReportQueries가 DB에서 집계한 것이고, 여기서는 시트로 옮기기만 한다.
 * exceljs writeBuffer는 자체 Buffer 타입(ArrayBuffer 계열)을 돌려준다 — Node Buffer로 감싸 돌려준다(decisions/0022와 같은 타입 문제).
 */
export async function buildWeeklyReportXlsx(data: WeeklyReportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = '단말온 terminal-ops';
  wb.created = new Date(data.generatedAt);
  const [summary, statusSheet, transitionSheet, flowSheet, anomalySheet, connSheet, rolloutSheet, vanSheet] = SHEET_NAMES.map((name) => wb.addWorksheet(name));

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const flowTotal = (k: 'received' | 'shipped' | 'returned') => sum(data.flows.map((f) => f[k]));
  table(summary, ['항목', '값'], [
    ['주', `${data.week.weekStart} ~ ${kstDate(new Date(new Date(data.week.to).getTime() - 1))} (KST)`],
    ['만든 시각', kst(data.generatedAt)],
    ['단말기 총수', sum(data.statusByModel.map((r) => r.count))],
    ['운영 중', sum(data.statusByModel.filter((r) => r.status === 'IN_SERVICE').map((r) => r.count))],
    ['지난주 상태 전이', sum(data.transitions.map((r) => r.count))],
    ['지난주 입고', flowTotal('received')],
    ['지난주 출고', flowTotal('shipped')],
    ['지난주 회수 입고', flowTotal('returned')],
    ['열린 이상 단말기', data.anomalies.total],
    ...data.anomalies.byRule.map((r): [string, number] => [`  ${ANOMALY_RULE_LABEL[r.rule as AnomalyRule] ?? r.rule}`, r.open]),
    ['온라인 / 오프라인', `${data.connectivity.online} / ${data.connectivity.offline}`],
    ['펌웨어 배포', data.rollouts.length],
    ['VAN 대조 어긋남', data.van ? `${data.van.confirmed} (#${data.van.runId})` : '실행 없음'],
    ['기준', '현황(상태·이상·접속)은 만든 시각, 전이·입출고·배포는 그 주. 배포의 대상·성공·실패 수는 배포마다 누적'],
  ]);
  // 기준 시점이 두 가지라 시트 첫 줄에 적는다(리뷰 반영, decisions/0035): 현황은 만든 시각, 전이·입출고·배포는 그 주
  const asOf = `생성 시점(${kst(data.generatedAt)} KST) 기준 현황 — 그 주 끝이 아니라 리포트를 만든 순간의 모습`;
  note(statusSheet, asOf);
  note(anomalySheet, asOf);
  note(connSheet, asOf);
  note(transitionSheet, `그 주(${data.week.weekStart} 주, KST) 기준`);
  note(flowSheet, `그 주(${data.week.weekStart} 주, KST) 기준`);
  note(rolloutSheet, '그 주에 진행 중이었거나 끝난 배포. 대상·성공·실패·시간 초과 수는 배포마다 누적(그 주 증분이 아니라 만든 시각까지)');
  note(vanSheet, '만든 시각까지 가장 최근에 끝난 VAN 대조');
  table(statusSheet, ['모델', '상태', '대수'], data.statusByModel.map((r) => [r.modelCode, r.status, r.count]));
  table(transitionSheet, ['출처', '도착 상태', '건수'], data.transitions.map((r) => [r.source, r.toStatus, r.count]));
  table(flowSheet, ['모델', '입고(신규 등록)', '출고', '회수 입고'], data.flows.map((r) => [r.modelCode, r.received, r.shipped, r.returned]));
  table(
    anomalySheet,
    ['시리얼', '지금 상태', '규칙', '처음 발견(KST)', '마지막 확인(KST)'],
    data.anomalies.items.map((r) => [r.serialNo, r.status, ANOMALY_RULE_LABEL[r.rule as AnomalyRule] ?? r.rule, kst(r.detectedAt), kst(r.lastSeenAt)]),
  );
  if (data.anomalies.total > data.anomalies.items.length) anomalySheet.addRow([`… 외 ${data.anomalies.total - data.anomalies.items.length}건(GET /anomalies?open=true)`]);
  table(connSheet, ['운영 중', '온라인', '오프라인', '기록 없음'], [[data.connectivity.inService, data.connectivity.online, data.connectivity.offline, data.connectivity.noRecord]]);
  table(
    rolloutSheet,
    ['배포', '모델', '버전', '상태', '시작(KST)', '끝(KST)', '대상(누적)', '성공(누적)', '실패(누적)', '시간 초과(누적)', '끝난 이유'],
    data.rollouts.map((r) => [r.id, r.modelCode, r.version, r.status, kst(r.createdAt), kst(r.finishedAt), r.targets, r.succeeded, r.failed, r.timedOut, r.endReason ?? '']),
  );
  table(
    vanSheet,
    ['항목', '값'],
    data.van
      ? [
          ['실행', `#${data.van.runId}`],
          ['끝난 시각(KST)', kst(data.van.finishedAt)],
          ['VAN 등록', data.van.fetched],
          ['후보', data.van.candidates],
          ['어긋남(재검증 뒤)', data.van.confirmed],
          ['재검증으로 풀림', data.van.resolved],
          ...Object.entries(KIND_LABEL).map(([kind, label]): [string, number] => [`  ${label}`, data.van!.counts[kind as VanMismatchKind] ?? 0]),
        ]
      : [['실행', '끝난 VAN 대조가 없습니다']],
  );
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
