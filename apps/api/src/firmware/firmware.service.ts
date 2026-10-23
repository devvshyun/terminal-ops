import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import { TerminalModel } from '../terminal/terminal-model.entity.js';
import type { RegisterFirmwareDto } from './dto/firmware.dto.js';
import { Firmware } from './firmware.entities.js';

/** 펌웨어 등록. (모델, 버전)이 이미 있으면 unique 위반 → 409 DUPLICATE(기존 예외 필터). */
@Injectable()
export class FirmwareService {
  constructor(private readonly em: EntityManager) {}

  async register(dto: RegisterFirmwareDto, actor: string): Promise<Firmware> {
    const em = this.em.fork();
    const model = await em.findOne(TerminalModel, { code: dto.modelCode });
    if (!model) throw new NotFoundException(`단말기 모델 ${dto.modelCode}이(가) 없습니다.`);
    const firmware = em.create(Firmware, { model, version: dto.version, createdBy: actor });
    await em.flush();
    return firmware;
  }
}

export function toFirmwareView(f: Firmware) {
  return { id: f.id, modelCode: f.model.code, version: f.version, createdBy: f.createdBy, createdAt: f.createdAt.toISOString() };
}
