import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { describeError } from './ErrorBox';

/**
 * describeError의 모양. LogoutButton(점주 앱 사본)이 `describeError(error).detail`을 부른다 — 사본 검사는 LogoutButton 코드만 보고
 * 이 앱의 ErrorBox는 새로 쓴 것이라(decisions/0062), detail이 서버 메시지·연결 오류 메시지를 담는다는 약속을 여기서 지킨다(리뷰 반영, 회귀 방지).
 */
describe('describeError (회귀 방지)', () => {
  it('api 오류: 현장 안내(title)와 서버 메시지(detail)·코드', () => {
    expect(describeError(new ApiError(409, 'SCAN_IN_PROGRESS', '처리 중인 스캔입니다.', null))).toEqual({
      title: '서버가 이 박스를 아직 처리하고 있습니다. 잠시 뒤 같은 박스를 다시 보내세요.',
      detail: '처리 중인 스캔입니다.',
      code: 'SCAN_IN_PROGRESS',
    });
    expect(describeError(new ApiError(500, null, '서버 오류', null))).toEqual({
      title: '요청이 실패했습니다(HTTP 500). 잠시 뒤 다시 시도하세요.',
      detail: '서버 오류',
      code: null,
    });
  });

  it('연결 실패(api 오류가 아님): detail은 오류 메시지, 오류가 아닌 값은 글자로', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toEqual({
      title: '서버에 연결하지 못했습니다. 연결을 확인하고 다시 시도하세요.',
      detail: 'Failed to fetch',
      code: null,
    });
    expect(describeError('끊김').detail).toBe('끊김');
  });
});
