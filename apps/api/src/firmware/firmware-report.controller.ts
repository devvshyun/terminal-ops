import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { DeviceAuth } from '../auth/access.js';
import { FirmwareReportDto } from './dto/firmware.dto.js';
import { FirmwareReportService } from './firmware-report.service.js';

/** 단말기가 부르는 API(하트비트와 같이 단말기 키, decisions/0055) */
@Controller('devices')
export class FirmwareReportController {
  constructor(private readonly reports: FirmwareReportService) {}

  @Post('firmware-reports')
  @DeviceAuth()
  @HttpCode(200)
  async report(@Body() dto: FirmwareReportDto) {
    return this.reports.report(dto);
  }
}
