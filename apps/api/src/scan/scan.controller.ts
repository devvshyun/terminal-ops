import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ScanView } from '@terminal-ops/contracts';
import { Operator } from '../common/operator.decorator.js';
import { summarize } from '../terminal/bulk-rows.js';
import { CreateScanDto } from './dto/create-scan.dto.js';
import type { ScanBatch } from './scan-batch.entity.js';
import { ScanService } from './scan.service.js';

function toScanView(batch: ScanBatch, replayed: boolean): ScanView {
  return {
    scanId: batch.scanId,
    kind: batch.kind,
    poNo: batch.poNo ?? null,
    actor: batch.actor,
    replayed,
    createdAt: batch.createdAt.toISOString(),
    summary: summarize(batch.results),
    results: batch.results,
  };
}

@Controller('scans')
export class ScanController {
  constructor(private readonly scans: ScanService) {}

  /** 새로 처리했으면 201, 같은 scanId를 다시 보내 저장된 결과를 돌려주면 200(replayed: true) */
  @Post()
  async scan(@Body() dto: CreateScanDto, @Operator() actor: string, @Res({ passthrough: true }) res: Response) {
    const { batch, replayed } = await this.scans.scan(dto, actor);
    res.status(replayed ? 200 : 201);
    return toScanView(batch, replayed);
  }

  @Get(':scanId')
  async get(@Param('scanId') scanId: string) {
    return toScanView(await this.scans.get(scanId), true);
  }
}
