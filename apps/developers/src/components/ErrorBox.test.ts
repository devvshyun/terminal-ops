import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { describeError } from './ErrorBox';

/**
 * describeError의 모양. LogoutButton(점주 앱 사본)이 `describeError(error).detail`을 부른다 — 사본 검사는 LogoutButton 코드만 보고
 * 이 앱의 ErrorBox는 새로 쓴 것이라(decisions/0075), detail이 서버 메시지·연결 오류 메시지를 담는다는 약속을 여기서 지킨다(관제 앱과 같은 회귀 방지).
 */
describe('describeError (회귀 방지)', () => {
  it('api 오류: 개발자센터 안내(title)와 서버 메시지(detail)·코드', () => {
    expect(describeError(new ApiError(409, 'DUPLICATE', '이미 존재하는 값입니다.', null))).toEqual({
      title: '같은 코드의 업체가 이미 있습니다.',
      detail: '이미 존재하는 값입니다.',
      code: 'DUPLICATE',
    });
    expect(describeError(new ApiError(404, null, '외부 업체 9이(가) 없습니다.', null)).title).toBe('찾는 업체·키가 없습니다.');
    expect(describeError(new ApiError(500, null, '서버 오류', null))).toEqual({ title: '요청이 실패했습니다(HTTP 500).', detail: '서버 오류', code: null });
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
