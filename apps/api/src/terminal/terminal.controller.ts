import { Body, Controller, Get, HttpCode, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { SingleFileInterceptor } from '../common/upload.interceptor.js';
import { RegisterTerminalDto } from './dto/register-terminal.dto.js';
import { ListTerminalsQuery } from './dto/list-terminals.query.js';
import { TransitionDto } from './dto/transition.dto.js';
import { TerminalImportService, type UploadedSpreadsheet } from './terminal-import.service.js';
import { TerminalService } from './terminal.service.js';
import { TransitionService } from './transition.service.js';
import { TransitionSource } from './terminal-status.js';
import { toHistoryView, toTerminalView } from './terminal.views.js';

@Controller('terminals')
export class TerminalController {
  constructor(
    private readonly terminals: TerminalService,
    private readonly transitions: TransitionService,
    private readonly imports: TerminalImportService,
  ) {}

  /**
   * 엑셀 일괄 등록. multipart의 file 필드(.xlsx, 2MB 이하) 하나만 받는다. multer 기본 메모리 저장소라 디스크에 쓰지 않는다.
   * defParamCharset utf8: 한글 파일 이름이 깨지지 않게(multer 기본은 latin1).
   * fields 0·parts 1: 글자 필드나 두 번째 part가 오면 바로 400 INVALID_FILE(파일 크기 초과는 413 FILE_TOO_LARGE, decisions/0022).
   */
  @Post('imports')
  @UseInterceptors(
    SingleFileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0, parts: 1 }, defParamCharset: 'utf8' }),
  )
  async import(@UploadedFile() file: UploadedSpreadsheet | undefined, @Operator() actor: string) {
    return this.imports.import(file, actor);
  }

  @Post()
  async register(@Body() dto: RegisterTerminalDto, @Operator() actor: string) {
    return toTerminalView(await this.terminals.register(dto, actor));
  }

  @Get()
  async list(@Query() query: ListTerminalsQuery) {
    const result = await this.terminals.list(query);
    return { ...result, items: result.items.map(toTerminalView) };
  }

  @Get(':serialNo')
  async get(@Param('serialNo') serialNo: string) {
    return toTerminalView(await this.terminals.getBySerial(serialNo));
  }

  @Get(':serialNo/history')
  async history(@Param('serialNo') serialNo: string) {
    return (await this.terminals.history(serialNo)).map(toHistoryView);
  }

  @Post(':serialNo/transitions')
  @HttpCode(200)
  async transition(@Param('serialNo') serialNo: string, @Body() dto: TransitionDto, @Operator() actor: string) {
    const terminal = await this.transitions.transition({
      serialNo,
      to: dto.to,
      reason: dto.reason,
      actor,
      source: TransitionSource.MANUAL,
      expectedVersion: dto.expectedVersion,
    });
    return toTerminalView(terminal);
  }
}
