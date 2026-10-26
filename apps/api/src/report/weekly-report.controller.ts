import { BadRequestException, Body, Controller, Get, Header, HttpCode, NotFoundException, Param, Post, StreamableFile } from '@nestjs/common';
import { attachmentDisposition } from '../common/content-disposition.js';
import { Operator } from '../common/operator.decorator.js';
import { SendWeeklyReportDto } from './dto/send-weekly-report.dto.js';
import { parseKstWeekStart, previousKstWeek, type KstWeek } from './kst-week.js';
import { toWeeklyReportView, WeeklyReportService } from './weekly-report.service.js';
import { XLSX_CONTENT_TYPE } from './weekly-report.xlsx.js';

function weekOf(weekStart: string): KstWeek {
  const week = parseKstWeekStart(weekStart);
  if (!week) throw new BadRequestException({ statusCode: 400, code: 'INVALID_WEEK_START', message: 'weekStart는 KST 월요일 날짜(YYYY-MM-DD)입니다.' });
  return week;
}

/** 주간 운영 리포트(F11). 주기 작업이 매주 월요일 09:00 KST에 지난주를 보내고, 운영자가 바로 보낼 수도 있다. */
@Controller('reports/weekly')
export class WeeklyReportController {
  constructor(private readonly reports: WeeklyReportService) {}

  /** 보내기(동기). 이미 보낸 주면 보내지 않고 alreadySent: true. 같은 주를 다른 요청이 보내는 중이면 409 */
  @Post()
  @HttpCode(200)
  async send(@Body() dto: SendWeeklyReportDto, @Operator() _actor: string) {
    const week = dto.weekStart ? weekOf(dto.weekStart) : previousKstWeek(new Date());
    const { report, alreadySent } = await this.reports.send(week);
    return toWeeklyReportView(report, alreadySent);
  }

  @Get(':weekStart')
  async get(@Param('weekStart') weekStart: string) {
    return toWeeklyReportView(await this.reports.get(weekOf(weekStart).weekStart));
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
