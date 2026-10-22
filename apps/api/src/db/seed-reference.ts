import type { EntityManager } from '@mikro-orm/mysql';
import { TerminalModel } from '../terminal/terminal-model.entity.js';
import { InspectionItem } from '../inspection/inspection-item.entity.js';

interface ModelSeed {
  code: string;
  name: string;
  requiresReinspection: boolean;
  /** 검수 항목 [코드, 이름], 순서대로 */
  items: [string, string][];
}

export const MODEL_SEEDS: ModelSeed[] = [
  {
    code: 'SN-100',
    name: '유선 카운터형',
    requiresReinspection: false,
    items: [['POWER', '전원'], ['NETWORK', '유선 통신'], ['CARD_READER', '카드리더'], ['PRINTER', '영수증 프린터']],
  },
  {
    code: 'SN-200',
    name: '무선 LTE형',
    requiresReinspection: true,
    items: [['POWER', '전원'], ['LTE', 'LTE 통신'], ['CARD_READER', '카드리더'], ['BATTERY', '배터리']],
  },
  {
    code: 'SN-300',
    name: '테이블오더 태블릿형',
    requiresReinspection: false,
    items: [['POWER', '전원'], ['NETWORK', '무선 통신'], ['TOUCHSCREEN', '터치스크린']],
  },
];

/** 기준 데이터(모델, 검수 항목)를 넣는다. 이미 있는 행은 건너뛰므로 여러 번 실행해도 된다. */
export async function seedReference(em: EntityManager): Promise<void> {
  for (const seed of MODEL_SEEDS) {
    let model = await em.findOne(TerminalModel, { code: seed.code });
    if (!model) {
      model = em.create(TerminalModel, { code: seed.code, name: seed.name, requiresReinspection: seed.requiresReinspection });
      await em.flush();
    }
    for (const [sortOrder, [code, label]] of seed.items.entries()) {
      const exists = await em.findOne(InspectionItem, { model, code });
      if (!exists) em.create(InspectionItem, { model, code, label, sortOrder });
    }
  }
  await em.flush();
}
