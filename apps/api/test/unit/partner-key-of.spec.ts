import { describe, expect, it } from 'vitest';
import { partnerKeyOf } from '../../src/auth/auth.guard.js';

/** 외부 업체 키를 어느 헤더에서 읽나(decisions/0054) — Bearer 먼저, 없을 때만 X-Api-Key */
describe('partnerKeyOf', () => {
  it('Bearer는 대소문자를 가리지 않고, 사이 공백이 여러 칸이어도 읽는다', () => {
    expect(partnerKeyOf('Bearer pk_a', undefined)).toBe('pk_a');
    expect(partnerKeyOf('bearer pk_a', undefined)).toBe('pk_a');
    expect(partnerKeyOf('BEARER    pk_a', undefined)).toBe('pk_a');
  });

  it('Bearer가 아닌 Authorization(Basic 등)은 무시하고 X-Api-Key를 쓴다', () => {
    expect(partnerKeyOf('Basic dXNlcjpwYXNz', 'pk_from_header')).toBe('pk_from_header');
    expect(partnerKeyOf(undefined, '  pk_from_header  ')).toBe('pk_from_header');
  });

  it('Bearer가 있으면 X-Api-Key보다 먼저 — Bearer 값이 틀려도 X-Api-Key로 넘어가지 않는다(가드가 401)', () => {
    expect(partnerKeyOf('Bearer wrong-key', 'pk_valid')).toBe('wrong-key');
  });

  it('둘 다 없으면 null', () => {
    expect(partnerKeyOf(undefined, undefined)).toBeNull();
    expect(partnerKeyOf('Bearer', undefined)).toBeNull();
  });
});
