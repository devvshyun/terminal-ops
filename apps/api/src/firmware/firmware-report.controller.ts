import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { FirmwareReportDto } from './dto/firmware.dto.js';
import { FirmwareReportService } from './firmware-report.service.js';

/** 단말기가 부르는 API(하트비트와 같이 작업자 헤더 없음) */
@Controller('devices')
export class FirmwareReportController {
  constructor(private readonly reports: FirmwareReportService) {}

  @Post('firmware-reports')
  @HttpCode(200)
  async report(@Body() dto: FirmwareReportDto) {
    return this.reports.report(dto);
  }
}
