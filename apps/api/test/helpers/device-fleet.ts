import { crc32 } from 'node:zlib';
import { Merchant } from '../../src/merchant/merchant.entity.js';
import { Terminal } from '../../src/terminal/terminal.entity.js';
import { TerminalModel } from '../../src/terminal/terminal-model.entity.js';
import { TerminalStatus } from '../../src/terminal/terminal-status.js';
import type { TestApp } from './test-app.js';

/** 시리얼 `<prefix>-0001` … */
export function serialsOf(prefix: string, count: number, start = 1): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${String(start + i).padStart(4, '0')}`);
}

/**
 * 테스트·실험 준비용: 운영 중(IN_SERVICE) 단말기 count대를 API를 거치지 않고 INSERT 몇 번으로 넣는다.
 * 전이 서비스·이력·Outbox를 거치지 않는다 — 하트비트·펌웨어 배포 테스트에 "이미 설치된 단말기 수천 대"가 필요할 뿐이고,
 * 실제 API로 만들면 대당 요청 6번이라 5,000대에 수 분이 걸린다. 운영 코드에서는 쓰지 않는다.
 */
export async function seedInService(t: TestApp, prefix: string, count: number, modelCode = 'SN-100', start = 1): Promise<string[]> {
  const em = t.orm.em.fork();
  const model = await em.findOneOrFail(TerminalModel, { code: modelCode });
  const merchant = await em.findOneOrFail(Merchant, { code: 'GANGNAM-KIMBAP' });
  const serials = serialsOf(prefix, count, start);
  const now = new Date();
  for (let i = 0; i < serials.length; i += 1000) {
    await em.insertMany(
      Terminal,
      serials.slice(i, i + 1000).map((serialNo) => ({
        serialNo,
        model,
        merchant,
        status: TerminalStatus.IN_SERVICE,
        statusChangedAt: now,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })),
    );
  }
  return serials;
}

/** 배포 대상 순서(시리얼 CRC32 오름차순, 같으면 id 순 — rollout.service.ts의 SQL과 같은 순서) */
export function rolloutOrder(serials: string[]): string[] {
  return [...serials].sort((a, b) => crc32(a) - crc32(b));
}
