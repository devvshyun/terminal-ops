import { describe, expect, it } from 'vitest';
import { MASK, redactJobData, shortReason } from '../../src/ops/job-data.js';

describe('실패 job data 가리기 (decisions/0072)', () => {
  it('지금 큐에 들어가는 data(id·시리얼·주 시작일)는 그대로 보인다', () => {
    for (const data of [{ shipmentId: 3 }, { outboxId: 12 }, { serialNo: 'SN1-0001' }, { runId: 7 }, { weekStart: '2026-10-19' }, {}]) {
      expect(redactJobData(data)).toEqual(data);
    }
  });

  it('비밀·개인정보처럼 보이는 이름의 값은 깊이와 상관없이 가린다(대소문자 무시)', () => {
    expect(
      redactJobData({ password: 'p', apiKey: 'k', Authorization: 'Bearer x', nested: { phoneNo: '010', list: [{ sessionId: 's', ok: 1 }] } }),
    ).toEqual({ password: MASK, apiKey: MASK, Authorization: MASK, nested: { phoneNo: MASK, list: [{ sessionId: MASK, ok: 1 }] } });
  });

  it('긴 글자는 100자로 자르고, 긴 목록은 20개까지, 너무 깊은 것은 [깊음]', () => {
    expect(redactJobData({ text: 'x'.repeat(101) })).toEqual({ text: `${'x'.repeat(100)}…(101자)` });
    expect((redactJobData({ ids: Array.from({ length: 25 }, (_, i) => i) }).ids as unknown[]).slice(-2)).toEqual([19, '…외 5개']);
    expect(redactJobData({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({ a: { b: { c: { d: '[깊음]' } } } });
  });

  it('객체가 아닌 data는 { value }로, 없으면 빈 객체. 실패 이유는 500자까지', () => {
    expect(redactJobData(null)).toEqual({});
    expect(redactJobData(undefined)).toEqual({});
    expect(redactJobData('글자')).toEqual({ value: '글자' });
    expect(redactJobData([1, 2])).toEqual({ value: [1, 2] });
    expect(shortReason('e'.repeat(600))).toBe(`${'e'.repeat(500)}…`);
    expect(shortReason(undefined)).toBe('');
  });
});
