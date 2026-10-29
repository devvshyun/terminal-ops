import { describe, expect, it } from 'vitest';
import { MASK, maskPii, redactJobData, shortReason } from '../../src/ops/job-data.js';

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

  it('연락처·주소·자격 증명·토큰 계열 이름도 가린다(Task 2 리뷰 반영)', () => {
    const data = { tel: '1', mobileNo: '2', addr1: '3', contactName: '4', credentials: '5', bearer: '6', jwt: '7', privateNote: '8', serialNo: 'SN1-0001' };
    expect(redactJobData(data)).toEqual({
      tel: MASK,
      mobileNo: MASK,
      addr1: MASK,
      contactName: MASK,
      credentials: MASK,
      bearer: MASK,
      jwt: MASK,
      privateNote: MASK,
      serialNo: 'SN1-0001',
    });
  });

  it('실패 이유 속 전화번호·이메일은 가린다(시리얼·id·HTTP 상태는 그대로, Task 2 리뷰 반영)', () => {
    expect(shortReason('수신자 010-1234-5678 / 01098765432 / 02-123-4567 발송 실패')).toBe(`수신자 ${MASK} / ${MASK} / ${MASK} 발송 실패`);
    expect(shortReason('owner.kim+a@example.co.kr에 보내지 못함')).toBe(`${MASK}에 보내지 못함`);
    expect(shortReason('SN1-0001 브릿지VAN 목록 응답 503 (run 20261029)')).toBe('SN1-0001 브릿지VAN 목록 응답 503 (run 20261029)');
    // 가린 뒤 500자로 자른다 — 잘린 자리에 번호 반쪽이 남지 않게
    expect(shortReason(`${'e'.repeat(495)} 010-1234-5678`)).toBe(`${'e'.repeat(495)} ${MASK}`);
  });

  it('maskPii: 전화번호·이메일 모양만 가리고 자르지 않는다 — 실패 이유와 최근 오류(/ops/errors)가 같이 쓴다(최종 리뷰 Important 1)', () => {
    expect(maskPii('톡톡메신저 400 수신자 010-1234-5678, a.b@example.com')).toBe(`톡톡메신저 400 수신자 ${MASK}, ${MASK}`);
    expect(maskPii('x'.repeat(600))).toHaveLength(600);
    expect(maskPii('SN1-0001 응답 503')).toBe('SN1-0001 응답 503');
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
