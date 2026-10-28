import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { lineProblem, newScanId, retryable, splitSerials } from './scan';

describe('박스 스캔 규칙 (decisions/0064, 어드민 ScanPage와 같은 멱등 규칙)', () => {
  it('스캐너 한 줄·붙여 넣은 글을 시리얼로(줄·쉼표·공백, 빈 것 제외, 순서 유지)', () => {
    expect(splitSerials(' A-0001 ')).toEqual(['A-0001']);
    expect(splitSerials('A-0001\n\n A-0002 ,A-0003\r\nA-0001')).toEqual(['A-0001', 'A-0002', 'A-0003', 'A-0001']);
    expect(splitSerials('   ')).toEqual([]);
  });

  it('줄마다 문제: 앞에 같은 것이 있으면 중복(처음 것은 괜찮다), 대문자·숫자·하이픈 4~32자가 아니면 형식', () => {
    const list = ['AB-0001', 'ab-0002', 'AB-0001', 'X1', 'Y'.repeat(33), 'OK-1'];
    expect(list.map((_, i) => lineProblem(list, i))).toEqual([null, 'FORMAT', 'DUPLICATE', 'FORMAT', 'FORMAT', null]);
  });

  it('다시 보내기(같은 scanId) 판정: 연결 실패·5xx·처리 중·박스 되돌림은 다시, 입력 오류는 고쳐서 새 scanId', () => {
    expect(retryable(new TypeError('Failed to fetch'))).toBe(true);
    expect(retryable(new ApiError(503, null, 'x', null))).toBe(true);
    expect(retryable(new ApiError(409, 'SCAN_IN_PROGRESS', 'x', null))).toBe(true);
    expect(retryable(new ApiError(409, 'VERSION_CONFLICT', 'x', null))).toBe(true);
    expect(retryable(new ApiError(400, null, 'x', null))).toBe(false);
    expect(retryable(new ApiError(422, 'SCAN_ID_REUSED', 'x', null))).toBe(false);
    expect(retryable(new ApiError(422, 'PO_CLOSED', 'x', null))).toBe(false);
  });

  it('scanId는 서버 규칙(영문·숫자·_·- 8~64자)에 맞고 매번 다르다', () => {
    const a = newScanId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(newScanId()).not.toBe(a);
  });
});
