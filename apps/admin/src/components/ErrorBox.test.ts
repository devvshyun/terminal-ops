import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { describeError } from './ErrorBox';

describe('describeError', () => {
  it('409 LAST_ADMIN은 다른 ADMIN을 먼저 만들라고 안내한다(서버 메시지는 detail에 그대로)', () => {
    const d = describeError(new ApiError(409, 'LAST_ADMIN', '마지막 활성 ADMIN은 …', {}));
    expect(d.title).toBe('마지막 활성 ADMIN입니다. 다른 ADMIN 계정을 먼저 만들거나 살린 뒤 바꾸세요.');
    expect(d.detail).toBe('마지막 활성 ADMIN은 …');
    expect(d.code).toBe('LAST_ADMIN');
  });

  it('코드가 없는 400은 입력값 확인', () => {
    expect(describeError(new ApiError(400, null, 'x', {})).title).toBe('입력값을 확인하세요.');
  });
});
