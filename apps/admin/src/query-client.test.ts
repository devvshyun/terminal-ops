import { describe, expect, it } from 'vitest';
import { ApiError } from './api/client';
import { shouldRetry } from './query-client';

describe('조회 재시도 판정 (decisions/0041)', () => {
  it('4xx는 다시 해도 같아서 재시도하지 않는다', () => {
    expect(shouldRetry(0, new ApiError(404, null, '없음', null))).toBe(false);
    expect(shouldRetry(0, new ApiError(409, 'VERSION_CONFLICT', '충돌', null))).toBe(false);
  });

  it('5xx·연결 실패(TypeError)는 한 번만 재시도한다', () => {
    expect(shouldRetry(0, new ApiError(502, null, 'Bad Gateway', null))).toBe(true);
    expect(shouldRetry(1, new ApiError(502, null, 'Bad Gateway', null))).toBe(false);
    expect(shouldRetry(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetry(1, new TypeError('Failed to fetch'))).toBe(false);
  });
});
