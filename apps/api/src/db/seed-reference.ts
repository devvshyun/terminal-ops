import type { EntityManager } from '@mikro-orm/mysql';
import { TerminalModel } from '../terminal/terminal-model.entity.js';

interface ModelSeed {
  code: string;
  name: string;
  requiresReinspection: boolean;
}

export const MODEL_SEEDS: ModelSeed[] = [
  { code: 'SN-100', name: '유선 카운터형', requiresReinspection: false },
  { code: 'SN-200', name: '무선 LTE형', requiresReinspection: true },
  { code: 'SN-300', name: '테이블오더 태블릿형', requiresReinspection: false },
];

/** 기준 데이터를 넣는다. 이미 있는 행은 건너뛰므로 여러 번 실행해도 된다. */
export async function seedReference(em: EntityManager): Promise<void> {
  for (const seed of MODEL_SEEDS) {
    const existing = await em.findOne(TerminalModel, { code: seed.code });
    if (!existing) em.create(TerminalModel, seed);
  }
  await em.flush();
}
