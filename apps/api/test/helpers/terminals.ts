import { Merchant } from '../../src/merchant/merchant.entity.js';
import { TerminalModel } from '../../src/terminal/terminal-model.entity.js';
import { Terminal } from '../../src/terminal/terminal.entity.js';
import type { TerminalStatus } from '../../src/terminal/terminal-status.js';
import type { TestApp } from './test-app.js';

export interface TerminalSeed {
  serialNo: string;
  status: TerminalStatus;
  /** 없으면 가맹점 없음(null) */
  merchantCode?: string | null;
  /** 기본 SN-100 */
  modelCode?: string;
}

/**
 * 테스트 준비용: 상태·가맹점을 정한 단말기를 API를 거치지 않고 INSERT로 넣는다(전이 서비스·이력·Outbox 없음).
 * 대조·이상 단말기 테스트는 "이미 이런 상태인 단말기"가 필요할 뿐이다. 운영 코드에서는 쓰지 않는다.
 * @returns 시리얼 → terminal.id
 */
export async function insertTerminals(t: TestApp, rows: TerminalSeed[]): Promise<Map<string, number>> {
  const em = t.orm.em.fork();
  const models = new Map((await em.find(TerminalModel, {})).map((m) => [m.code, m.id]));
  const merchants = new Map((await em.find(Merchant, {})).map((m) => [m.code, m.id]));
  const now = new Date();
  for (let i = 0; i < rows.length; i += 1000) {
    await em.insertMany(
      Terminal,
      rows.slice(i, i + 1000).map((r) => ({
        serialNo: r.serialNo,
        model: models.get(r.modelCode ?? 'SN-100')!,
        merchant: r.merchantCode ? merchants.get(r.merchantCode)! : null,
        status: r.status,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })),
    );
  }
  const saved = await em.find(Terminal, { serialNo: { $in: rows.map((r) => r.serialNo) } }, { fields: ['id', 'serialNo'] });
  return new Map(saved.map((s) => [s.serialNo, s.id]));
}
