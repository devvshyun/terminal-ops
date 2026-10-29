import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LoadStrategy } from '@mikro-orm/mysql';
import type { FirmwareView } from '@terminal-ops/contracts';
import { beforeIdWhere, keysetPage } from '../common/keyset.js';
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

  /**
   * 등록된 펌웨어(최근 등록부터, ?modelCode=&beforeId=&limit=). 배포 만들기 화면의 버전 선택지(decisions/0066).
   * 모델 조건은 모델 코드로 받아 모델 행을 먼저 찾는다 — 없는 모델이면 빈 목록(404가 아니다: 거르기 조건이라서).
   */
  async list(q: { modelCode?: string; beforeId?: number; limit: number }): Promise<{ items: Firmware[]; nextBeforeId: number | null }> {
    const em = this.em.fork();
    let modelWhere = {};
    if (q.modelCode) {
      const model = await em.findOne(TerminalModel, { code: q.modelCode });
      if (!model) return { items: [], nextBeforeId: null };
      modelWhere = { model: model.id };
    }
    const rows = await em.find(
      Firmware,
      { ...beforeIdWhere(q.beforeId), ...modelWhere },
      { populate: ['model'], strategy: LoadStrategy.SELECT_IN, orderBy: { id: 'desc' }, limit: q.limit + 1 },
    );
    return keysetPage(rows, q.limit);
  }
}

export function toFirmwareView(f: Firmware): FirmwareView {
  return { id: f.id, modelCode: f.model.code, version: f.version, createdBy: f.createdBy, createdAt: f.createdAt.toISOString() };
}
