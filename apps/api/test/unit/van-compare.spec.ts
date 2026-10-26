import { describe, expect, it } from 'vitest';
import { TerminalStatus } from '../../src/terminal/terminal-status.js';
import { betterRegistration, classify, ourValueOf, serialKey, vanValueOf } from '../../src/van/van-compare.js';
import { VanMismatchKind as K, VanStatus } from '../../src/van/van.entities.js';

const our = (status: TerminalStatus, merchantCode: string | null = 'GANGNAM-KIMBAP') => ({ status, merchantCode });
const van = (status: VanStatus, merchantCode = 'GANGNAM-KIMBAP') => ({ status, merchantCode });

describe('VAN 대조 종류 정하기(classify, decisions/0033)', () => {
  it.each([
    ['운영 중 + VAN 없음', our(TerminalStatus.IN_SERVICE), null, K.NOT_REGISTERED],
    ['운영 중 + VAN 해지', our(TerminalStatus.IN_SERVICE), van(VanStatus.CANCELLED), K.NOT_REGISTERED],
    ['운영 중 + VAN 정지', our(TerminalStatus.IN_SERVICE), van(VanStatus.SUSPENDED), K.SUSPENDED_WHILE_IN_SERVICE],
    ['운영 중 + VAN 활성, 가맹점 다름', our(TerminalStatus.IN_SERVICE), van(VanStatus.ACTIVE, 'YEOKSAM-CAFE'), K.MERCHANT_MISMATCH],
    ['운영 중인데 우리 가맹점 없음 + VAN 활성', our(TerminalStatus.IN_SERVICE, null), van(VanStatus.ACTIVE), K.MERCHANT_MISMATCH],
    ['운영 중 + VAN 활성, 가맹점 같음', our(TerminalStatus.IN_SERVICE), van(VanStatus.ACTIVE), null],
    ['회수됨 + VAN 활성', our(TerminalStatus.RETURNED), van(VanStatus.ACTIVE), K.REGISTERED_BUT_NOT_IN_SERVICE],
    ['우리 DB에 없음 + VAN 활성', null, van(VanStatus.ACTIVE), K.REGISTERED_BUT_NOT_IN_SERVICE],
    ['폐기 + VAN 해지', our(TerminalStatus.DISPOSED), van(VanStatus.CANCELLED), null],
    ['회수됨 + VAN 정지', our(TerminalStatus.RETURNED), van(VanStatus.SUSPENDED), null],
    ['재고 + VAN 없음', our(TerminalStatus.IN_STOCK), null, null],
  ])('%s → %s', (_name, o, v, expected) => {
    expect(classify(o, v)).toBe(expected);
  });

  it('값 표시: 상태 / 가맹점, 없으면 그렇다고 적는다', () => {
    expect(ourValueOf(our(TerminalStatus.IN_SERVICE, null))).toBe('IN_SERVICE / 가맹점 없음');
    expect(ourValueOf(null)).toBe('우리 DB에 없음');
    expect(vanValueOf(van(VanStatus.SUSPENDED))).toBe('SUSPENDED / GANGNAM-KIMBAP');
    expect(vanValueOf(null)).toBe('VAN에 없음');
  });
  it('가맹점 코드는 SQL 비교(utf8mb4_0900_ai_ci)와 같게 대소문자·앞뒤 공백을 무시한다', () => {
    expect(classify(our(TerminalStatus.IN_SERVICE, 'GANGNAM-KIMBAP'), van(VanStatus.ACTIVE, ' gangnam-kimbap'))).toBeNull();
    expect(classify(our(TerminalStatus.IN_SERVICE, 'GANGNAM-KIMBAP'), van(VanStatus.ACTIVE, 'YEOKSAM-CAFE'))).toBe(K.MERCHANT_MISMATCH);
  });

  it('시리얼 키: 앞뒤 공백을 지우고 대문자로(테이블 collation과 같은 동치)', () => {
    expect(serialKey(' vr-001 ')).toBe('VR-001');
    expect(serialKey('VR-001')).toBe(serialKey('vr-001'));
  });

  it('같은 시리얼의 VAN 등록이 둘이면 ACTIVE > SUSPENDED > CANCELLED, 같으면 updatedAt이 나중인 것', () => {
    const r = (status: VanStatus, at: string) => ({ status, updatedAt: new Date(at) });
    const active = r(VanStatus.ACTIVE, '2026-10-01T00:00:00Z');
    const cancelledLater = r(VanStatus.CANCELLED, '2026-10-20T00:00:00Z');
    const suspended = r(VanStatus.SUSPENDED, '2026-10-02T00:00:00Z');
    expect(betterRegistration(active, cancelledLater)).toBe(active);
    expect(betterRegistration(cancelledLater, active)).toBe(active);
    expect(betterRegistration(cancelledLater, suspended)).toBe(suspended);
    const activeLater = r(VanStatus.ACTIVE, '2026-10-05T00:00:00Z');
    expect(betterRegistration(active, activeLater)).toBe(activeLater);
    expect(betterRegistration(activeLater, active)).toBe(activeLater);
  });
});
