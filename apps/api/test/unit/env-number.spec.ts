import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS, intFromEnv } from '../../src/config/env-number.js';

const MS = { min: 1, max: DAY_MS };

describe('intFromEnv — 숫자 환경변수 검증 (Day 4 리뷰 Minor, decisions/0032)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('없거나 빈 글자(공백)면 기본값, 정수 글자면 그 값(앞뒤 공백은 무시)', () => {
    expect(intFromEnv('X', 2000, MS, {})).toBe(2000);
    expect(intFromEnv('X', 2000, MS, { X: '' })).toBe(2000);
    expect(intFromEnv('X', 2000, MS, { X: '  ' })).toBe(2000);
    expect(intFromEnv('X', 2000, MS, { X: ' 1500 ' })).toBe(1500);
  });

  it.each(['abc', '10s', '1.5', '1e3', '0x10', '99999999999999999999'])('정수 글자가 아닌 %s는 이름과 값을 담아 던진다', (raw) => {
    expect(() => intFromEnv('RELAY_INTERVAL_MS', 2000, MS, { RELAY_INTERVAL_MS: raw })).toThrow(/환경변수 RELAY_INTERVAL_MS=.*정수가 아닙니다/);
  });

  it('범위 밖이면 던진다(0ms 주기, 하루보다 긴 주기, 음수 포트)', () => {
    expect(() => intFromEnv('X', 1, MS, { X: '0' })).toThrow(/범위 1~86400000 밖/);
    expect(() => intFromEnv('X', 1, MS, { X: String(DAY_MS + 1) })).toThrow(/범위/);
    expect(() => intFromEnv('P', 1, { min: 0, max: 65_535 }, { P: '-1' })).toThrow(/범위 0~65535 밖/);
  });

  it('env 모듈은 숫자가 아닌 주기 값이 있으면 불러올 때 던진다(서버·워커가 뜨지 않는다)', async () => {
    vi.stubEnv('RELAY_INTERVAL_MS', 'abc');
    vi.resetModules();
    await expect(import('../../src/config/env.js')).rejects.toThrow(/RELAY_INTERVAL_MS/);
  });
});
