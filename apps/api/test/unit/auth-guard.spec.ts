import { describe, expect, it } from 'vitest';
import { testPrincipal } from '../../src/auth/auth.guard.js';
import { readCookie } from '../../src/auth/cookies.js';
import { resolveAuthTestHeaders } from '../../src/config/auth-test-headers.js';

describe('테스트 전용 인증 헤더 스위치 (decisions/0056)', () => {
  it('켜지 않으면 false', () => {
    expect(resolveAuthTestHeaders(undefined, 'test')).toBe(false);
    expect(resolveAuthTestHeaders('0', 'production')).toBe(false);
  });

  it('NODE_ENV=test에서만 켤 수 있다 — 아니면 던진다(서버가 뜨지 않는다)', () => {
    expect(resolveAuthTestHeaders('1', 'test')).toBe(true);
    expect(resolveAuthTestHeaders('true', 'test')).toBe(true);
    expect(() => resolveAuthTestHeaders('1', 'production')).toThrow(/테스트\(NODE_ENV=test\)에서만/);
    expect(() => resolveAuthTestHeaders('1', undefined)).toThrow(/테스트\(NODE_ENV=test\)에서만/);
  });
});

describe('테스트 전용 헤더의 사람', () => {
  it('X-Operator가 로그인 아이디, 역할 기본은 OPERATOR. 한글은 URL 인코딩', () => {
    expect(testPrincipal('kim', undefined)).toEqual({ accountId: null, loginId: 'kim', displayName: 'kim', role: 'OPERATOR', merchantId: null, merchantCode: null });
    expect(testPrincipal(encodeURIComponent('김운영'), 'FIELD')).toMatchObject({ loginId: '김운영', role: 'FIELD' });
  });

  it('이름 규칙(1~50자, system: 금지)과 역할(MERCHANT·모르는 값 거절)을 어기면 null', () => {
    for (const [name, role] of [
      [undefined, undefined],
      ['', undefined],
      ['x'.repeat(51), undefined],
      ['system:batch', undefined],
      ['%E0%A4%A', undefined],
      ['kim', 'MERCHANT'],
      ['kim', 'ROOT'],
    ] as const) {
      expect(testPrincipal(name, role)).toBeNull();
    }
  });
});

describe('쿠키 읽기', () => {
  it('이름이 정확히 같은 것의 값, 없으면 null', () => {
    expect(readCookie('a=1; sid=abc; b=2', 'sid')).toBe('abc');
    expect(readCookie('xsid=nope; sid=yes', 'sid')).toBe('yes');
    expect(readCookie('sid=', 'sid')).toBeNull();
    expect(readCookie(undefined, 'sid')).toBeNull();
    expect(readCookie('other=1', 'sid')).toBeNull();
  });
});
