import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDeviceApiKey } from '../../src/config/device-api-key.js';

/** 저장소 루트 .env.example의 DEVICE_API_KEY 줄 값(자리표시자) */
function exampleValue(): string {
  const text = readFileSync(resolve(__dirname, '../../../../.env.example'), 'utf8');
  const line = text.split(/\r?\n/).find((l) => l.startsWith('DEVICE_API_KEY='));
  expect(line).toBeDefined();
  return line!.slice('DEVICE_API_KEY='.length);
}

describe('DEVICE_API_KEY 시작 검사(decisions/0055, 최종 리뷰 Minor 2·6)', () => {
  it('없거나 16자 미만이면 던진다', () => {
    expect(() => resolveDeviceApiKey(undefined)).toThrow(/DEVICE_API_KEY가 없습니다/);
    expect(() => resolveDeviceApiKey('')).toThrow(/DEVICE_API_KEY가 없습니다/);
    expect(() => resolveDeviceApiKey('short-key-12345')).toThrow(/16자 이상/);
  });

  it('.env.example의 자리표시자를 그대로 쓰면 던진다(복사만 하고 바꾸지 않은 경우)', () => {
    const placeholder = exampleValue();
    expect(placeholder.length).toBeGreaterThanOrEqual(16);
    expect(() => resolveDeviceApiKey(placeholder)).toThrow(/자리표시자/);
    // change-me로 시작하는 값은 모두 자리표시자로 본다
    expect(() => resolveDeviceApiKey('change-me-0123456789abcdef')).toThrow(/자리표시자/);
  });

  it('헤더에 넣을 수 있는 ASCII(공백 없는 0x21~0x7E)만 받는다 — device-sim과 같은 규칙', () => {
    for (const bad of ['키-0123456789abcdef', 'key with space 0123', 'key\t0123456789abcdef', 'key\n0123456789abcdef']) {
      expect(() => resolveDeviceApiKey(bad), JSON.stringify(bad)).toThrow(/공백 없는 ASCII/);
    }
  });

  it('맞는 값은 그대로 돌려준다', () => {
    expect(resolveDeviceApiKey('ok-KEY_0123.456~!')).toBe('ok-KEY_0123.456~!');
    expect(resolveDeviceApiKey('test-device-key-0123456789')).toBe('test-device-key-0123456789');
  });
});
