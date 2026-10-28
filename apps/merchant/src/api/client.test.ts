import { describe, expect, it } from 'vitest';
import { getMe } from '../session';
import { loginAs, mockApi } from '../test/render';
import { api, ApiError, toQueryString } from './client';

describe('api 클라이언트 (어드민 client와 같은 규칙, decisions/0058)', () => {
  it('빈 값은 쿼리에서 빼고, /api 앞붙임으로 부른다', async () => {
    expect(toQueryString({ a: 1, b: '', c: null, d: undefined, e: 'x y' })).toBe('?a=1&e=x+y');
    const { calls } = mockApi({ 'GET /me/terminals': () => ({ body: { items: [] } }) });
    await api('/me/terminals', { query: { size: 100, status: undefined } });
    expect(calls[0].path).toBe('/me/terminals');
    expect(calls[0].query.toString()).toBe('size=100');
  });

  it('오류는 ApiError(status·code·message) — 검증 오류 배열은 이어 붙인다', async () => {
    mockApi({
      'POST /me/service-tickets': () => ({ status: 400, body: { statusCode: 400, message: ['symptom은 공백만으로 쓸 수 없습니다.', 'serialNo must be a string'] } }),
      'GET /me/service-tickets/:id': () => ({ status: 409, body: { statusCode: 409, code: 'TICKET_ALREADY_OPEN', message: '이미 열린 A/S 접수가 있습니다.' } }),
    });
    const bad = await api('/me/service-tickets', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(ApiError);
    expect(bad).toMatchObject({ status: 400, code: null, message: 'symptom은 공백만으로 쓸 수 없습니다., serialNo must be a string' });
    expect(await api('/me/service-tickets/1').catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'TICKET_ALREADY_OPEN' });
  });

  it('401이면 로그인 정보를 비운다. 로그인 요청 자체의 401(비밀번호 틀림)은 그대로 둔다', async () => {
    mockApi({
      'GET /me/terminals': () => ({ status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: 'x' } }),
      'POST /auth/login': () => ({ status: 401, body: { statusCode: 401, code: 'LOGIN_FAILED', message: 'x' } }),
    });
    loginAs();
    await api('/auth/login', { method: 'POST', body: {} }).catch(() => undefined);
    expect(getMe()).not.toBeNull();
    await api('/me/terminals').catch(() => undefined);
    expect(getMe()).toBeNull();
  });
});
