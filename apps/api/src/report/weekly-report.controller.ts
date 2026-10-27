import { BadRequestException, Body, Controller, Get, Header, NotFoundException, Param, Post, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import type { ApiErrorBody } from '@terminal-ops/contracts';
import { attachmentDisposition } from '../common/content-disposition.js';
import { Operator } from '../common/operator.decorator.js';
import { ListWeeklyReportsQuery } from './dto/list-weekly-reports.query.js';
import { SendWeeklyReportDto } from './dto/send-weekly-report.dto.js';
import { parseKstWeekStart, previousKstWeek, type KstWeek } from './kst-week.js';
import { toWeeklyReportView, WeeklyReportService } from './weekly-report.service.js';
import { XLSX_CONTENT_TYPE } from './weekly-report.xlsx.js';

function weekOf(weekStart: string): KstWeek {
  const week = parseKstWeekStart(weekStart);
  if (!week) throw new BadRequestException({ statusCode: 400, code: 'INVALID_WEEK_START', message: 'weekStart는 KST 월요일 날짜(YYYY-MM-DD)입니다.' } satisfies ApiErrorBody);
  return week;
}

/** 주간 운영 리포트(F11). 주기 작업이 매주 월요일 09:00 KST에 지난주를 보내고, 운영자가 바로 보낼 수도 있다. */
@Controller('reports/weekly')
export class WeeklyReportController {
  constructor(private readonly reports: WeeklyReportService) {}

  /**
   * 보내기 요청(비동기, decisions/0038). report 큐에 job을 넣고 202 { queued: true }. 이미 보낸 주면 job 없이 200 { alreadySent: true }.
   * 끝나지 않은 주는 422 WEEK_NOT_ENDED. 결과(SENT·lastError)는 GET /reports/weekly/:weekStart로 본다.
   */
  @Post()
  async send(@Body() dto: SendWeeklyReportDto, @Operator() _actor: string, @Res({ passthrough: true }) res: Response) {
    const week = dto.weekStart ? weekOf(dto.weekStart) : previousKstWeek(new Date());
    const { report, alreadySent, queued } = await this.reports.request(week);
    res.status(queued ? 202 : 200);
    return toWeeklyReportView(report, alreadySent, queued);
  }

  /**
   * 주 목록(최근 주부터, ?before=YYYY-MM-DD&limit=). 파일은 읽지 않는다(lazy).
   * queued·queuedAt은 주마다 큐를 본다(limit 상한 100, 한꺼번에 — 왕복을 차례로 기다리지 않는다) — 이미 보낸 주는 Redis를 보지 않는다(queueState)
   */
  @Get()
  async list(@Query() query: ListWeeklyReportsQuery) {
    const { items, nextBefore } = await this.reports.list(query);
    const states = await Promise.all(items.map((r) => this.reports.queueState(r)));
    return { items: items.map((r, i) => toWeeklyReportView(r, false, states[i].queued, states[i].queuedAt)), nextBefore };
  }

  /** 상태. queued: 수동 보내기 job이 아직 대기·처리 중, queuedAt: 그 job을 넣은 시각(POST 응답에는 없다 — 화면은 GET으로 다시 읽는다) */
  @Get(':weekStart')
  async get(@Param('weekStart') weekStart: string) {
    const report = await this.reports.get(weekOf(weekStart).weekStart);
    const { queued, queuedAt } = await this.reports.queueState(report);
    return toWeeklyReportView(report, false, queued, queuedAt);
  }

  /** 저장된 xlsx 내려받기. 파일 이름이 한글이라 filename*(RFC 5987)로 보낸다. 운영 수치라 중간 캐시에 남지 않게 no-store */
  @Get(':weekStart/file')
  @Header('Cache-Control', 'no-store')
  async file(@Param('weekStart') weekStart: string) {
    const report = await this.reports.get(weekOf(weekStart).weekStart);
    const file = await this.reports.file(report.id);
    if (!file || !report.fileName) throw new NotFoundException(`${weekStart} 주간 리포트 파일이 아직 없습니다.`);
    return new StreamableFile(file, {
      type: XLSX_CONTENT_TYPE,
      length: file.length,
      disposition: attachmentDisposition(report.fileName, `weekly-report-${report.weekStart}.xlsx`),
    });
  }
}
