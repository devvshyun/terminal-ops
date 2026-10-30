import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { ServerDown } from '../lib/servers';
import { describeError } from './ErrorBox';

/** describeError의 모양. LogoutButton(점주 앱 사본)이 `describeError(error).detail`을 부른다 — detail이 서버 메시지·연결 오류를 담는다는 약속(회귀 방지) */
describe('describeError (회귀 방지)', () => {
  it('api 오류: 시연 안내(title)와 서버 메시지(detail)·코드', () => {
    expect(describeError(new ApiError(409, 'ROLLOUT_ALREADY_ACTIVE', '진행 중', null)).title).toMatch(/진행 중인 배포가 끝나면/);
    expect(describeError(new ApiError(500, null, '서버 오류', null))).toEqual({ title: '요청이 실패했습니다(HTTP 500).', detail: '서버 오류', code: null });
  });

  it('두 서버가 안 떠 있으면 띄우는 명령, 연결 실패는 오류 메시지', () => {
    expect(describeError(new ServerDown('sim')).detail).toContain('cd apps/device-sim');
    expect(describeError(new TypeError('Failed to fetch')).detail).toBe('Failed to fetch');
  });
});
