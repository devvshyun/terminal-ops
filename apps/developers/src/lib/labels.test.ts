import { describe, expect, it } from 'vitest';
import { codeClass, endOfKstDay, keyState, PARTNER_CODE, scopesText } from './labels';

describe('개발자센터 이름표', () => {
  it('키 상태: 폐기 > 만료 > 사용 중(만료 시각과 같으면 만료)', () => {
    const now = new Date('2026-10-29T06:00:00.000Z');
    expect(keyState({ revokedAt: '2026-10-28T00:00:00Z', expiresAt: '2026-10-27T00:00:00Z' }, now)).toBe('revoked');
    expect(keyState({ revokedAt: null, expiresAt: '2026-10-29T06:00:00.000Z' }, now)).toBe('expired');
    expect(keyState({ revokedAt: null, expiresAt: '2026-10-29T06:00:01.000Z' }, now)).toBe('active');
    expect(keyState({ revokedAt: null, expiresAt: null }, now)).toBe('active');
  });

  it('범위 이름은 발급 폼 순서로', () => {
    expect(scopesText(['merchant-terminals:read', 'terminal-status:read'])).toBe('단말기 상태 · 가맹점 단말기 목록');
  });

  it('상태 코드 색 묶음', () => {
    expect([200, 204, 304, 400, 403, 404, 500, 503].map(codeClass)).toEqual(['code-2xx', 'code-2xx', 'code-2xx', 'code-4xx', 'code-4xx', 'code-4xx', 'code-5xx', 'code-5xx']);
  });

  it('만료일은 그날 끝 KST(UTC 14:59:59), 빈 값·모양이 틀리면 null', () => {
    expect(endOfKstDay('2027-01-31')).toBe('2027-01-31T14:59:59.000Z');
    expect(endOfKstDay('')).toBeNull();
    expect(endOfKstDay('2027-1-3')).toBeNull();
  });

  it('업체 코드 규칙(api와 같다)', () => {
    expect(['HANOL-POS', 'AB', 'A1-2'].every((c) => PARTNER_CODE.test(c))).toBe(true);
    expect(['A', 'hanol', 'A'.repeat(21), 'A B'].some((c) => PARTNER_CODE.test(c))).toBe(false);
  });
});
