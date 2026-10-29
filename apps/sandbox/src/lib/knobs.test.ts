import { describe, expect, it } from 'vitest';
import { faultsOn, PARTNERS, toInput, toServerValue } from './knobs';

const bungae = PARTNERS.find((p) => p.key === 'bungae')!;
const knob = (key: string) => bungae.knobs.find((k) => k.key === key)!;

describe('업체 손잡이', () => {
  it('업체 다섯, 서버 설정 키 이름 그대로', () => {
    expect(PARTNERS.map((p) => p.key)).toEqual(['bungae', 'neurimbo', 'seum', 'bridgevan', 'toktok']);
  });

  it('확률은 화면 %, 서버 0~1. 범위 밖·빈 값·음수는 보내지 않는다(null)', () => {
    expect(toServerValue(knob('force429Rate'), '30')).toBe(0.3);
    expect(toServerValue(knob('force429Rate'), '12.5')).toBe(0.125);
    expect(toServerValue(knob('force429Rate'), '101')).toBeNull();
    expect(toServerValue(knob('force429Rate'), '')).toBeNull();
    expect(toServerValue(knob('force429Rate'), '-1')).toBeNull();
    expect(toInput(knob('force429Rate'), 0.3)).toBe('30');
  });

  it('정수·ms는 정수만, 상한까지', () => {
    expect(toServerValue(knob('delayMs'), '1500')).toBe(1500);
    expect(toServerValue(knob('delayMs'), '1.5')).toBeNull();
    expect(toServerValue(knob('delayMs'), '60001')).toBeNull();
  });

  it('켜진 장애: 장애 손잡이 중 0이 아닌 것(진행 속도·한도 같은 정상 손잡이는 빼고)', () => {
    expect(faultsOn(bungae, { force429Rate: 0.3, rateLimitPerSec: 10, duplicateRate: 0, delayMs: 0, advancePerPoll: 1 })).toEqual(['429 확률']);
    expect(faultsOn(bungae, { force429Rate: 0, rateLimitPerSec: 10, duplicateRate: 0, delayMs: 0, advancePerPoll: 1 })).toEqual([]);
    const neurimbo = PARTNERS.find((p) => p.key === 'neurimbo')!;
    expect(faultsOn(neurimbo, { error5xxRate: 0, delayMs: 0, shuffle: true, advancePerPoll: 1 })).toEqual(['이벤트 순서 섞기']);
  });
});

describe('손잡이 ↔ 가상 업체 서버 설정(어긋남 검사)', () => {
  it('모든 손잡이 키가 apps/partners/src/state.ts의 그 업체 설정 인터페이스에 있다', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../partners/src/state.ts'), 'utf8');
    const iface: Record<string, string> = { bungae: 'BungaeConfig', neurimbo: 'NeurimboConfig', toktok: 'ToktokConfig', seum: 'SeumConfig', bridgevan: 'BridgevanConfig' };
    for (const p of PARTNERS) {
      const body = source.match(new RegExp(`interface ${iface[p.key]} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
      expect(body, iface[p.key]).not.toBe('');
      for (const k of p.knobs) expect(body, `${p.key}.${k.key}`).toMatch(new RegExp(`\\n\\s+${k.key}: (number|boolean);`));
    }
  });
});
