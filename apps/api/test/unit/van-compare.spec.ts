import { describe, expect, it } from 'vitest';
import { TerminalStatus } from '../../src/terminal/terminal-status.js';
import { classify, ourValueOf, vanValueOf } from '../../src/van/van-compare.js';
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
});
