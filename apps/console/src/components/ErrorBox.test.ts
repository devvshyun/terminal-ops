import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { describeError } from './ErrorBox';

/**
 * describeError의 모양. LogoutButton(점주 앱 사본)이 `describeError(error).detail`을 부른다 — 사본 검사는 LogoutButton 코드만 보고
 * 이 앱의 ErrorBox는 새로 쓴 것이라(decisions/0075), detail이 서버 메시지·연결 오류 메시지를 담는다는 약속을 여기서 지킨다(현장 앱과 같은 회귀 방지).
 */
describe('describeError (회귀 방지)', () => {
  it('api 오류: 관제 안내(title)와 서버 메시지(detail)·코드', () => {
    expect(describeError(new ApiError(409, 'JOB_NOT_FAILED', '실패 상태가 아닌 job입니다(지금 completed): report 3', null))).toEqual({
      title: '이 job은 이미 실패 상태가 아닙니다(다른 사람이 먼저 다시 시도했거나 지웠을 수 있습니다). 목록을 다시 읽었습니다.',
      detail: '실패 상태가 아닌 job입니다(지금 completed): report 3',
      code: 'JOB_NOT_FAILED',
    });
    expect(describeError(new ApiError(404, null, 'job이 없습니다: report 9', null)).title).toBe('찾는 큐·job이 없습니다(이미 지워졌을 수 있습니다).');
    expect(describeError(new ApiError(500, null, '서버 오류', null))).toEqual({ title: '요청이 실패했습니다(HTTP 500).', detail: '서버 오류', code: null });
  });

  it('503(관제 읽기의 Redis 시간 제한, Task 1 리뷰 반영 8b3f9a4): 잠시 뒤 다시 보라는 안내와 서버 메시지', () => {
    const message = 'Redis가 2000ms 안에 답하지 않습니다(큐 요약). 잠시 뒤 다시 보세요';
    expect(describeError(new ApiError(503, null, message, null))).toEqual({
      title: 'api가 Redis를 제때 읽지 못했습니다(HTTP 503). 잠시 뒤 다시 보세요.',
      detail: message,
      code: null,
    });
  });

  it('연결 실패(api 오류가 아님): detail은 오류 메시지, 오류가 아닌 값은 글자로', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toEqual({
      title: 'api 서버에 연결하지 못했습니다. api가 떠 있는지 확인하세요.',
      detail: 'Failed to fetch',
      code: null,
    });
    expect(describeError('끊김').detail).toBe('끊김');
  });
});
