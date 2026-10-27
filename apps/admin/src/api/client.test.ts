import { describe, expect, it } from 'vitest';
import { setOperator } from '../operator';
import { mockApi } from '../test/render';
import { api, ApiError, toQueryString } from './client';

describe('api 클라이언트 (decisions/0041)', () => {
  it('/api를 붙여 부르고, 작업자 이름이 있으면 X-Operator를 URL 인코딩해 붙인다', async () => {
    const { calls } = mockApi({ 'POST /terminals': () => ({ status: 201, body: { serialNo: 'A-1' } }) });
    setOperator('김운영');
    expect(await api('/terminals', { method: 'POST', body: { serialNo: 'A-1' } })).toEqual({ serialNo: 'A-1' });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/terminals', body: { serialNo: 'A-1' } });
    expect(calls[0].headers).toMatchObject({ 'X-Operator': encodeURIComponent('김운영'), 'Content-Type': 'application/json' });
  });

  it('작업자 이름이 없으면 X-Operator를 보내지 않는다', async () => {
    const { calls } = mockApi({ 'GET /health': () => ({ body: { status: 'ok' } }) });
    await api('/health');
    expect(calls[0].headers['X-Operator']).toBeUndefined();
  });

  it('쿼리는 빈 값을 뺀다', () => {
    expect(toQueryString({ status: 'IN_STOCK', q: '', modelCode: undefined, page: 2, open: false })).toBe('?status=IN_STOCK&page=2&open=false');
    expect(toQueryString({})).toBe('');
  });

  it('오류 응답은 ApiError(status·code·message). 409 VERSION_CONFLICT는 isVersionConflict', async () => {
    mockApi({
      'POST /terminals/:serialNo/transitions': () => ({ status: 409, body: { statusCode: 409, code: 'VERSION_CONFLICT', message: '다른 작업이 먼저 …' } }),
    });
    const error = await api('/terminals/A-1/transitions', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'VERSION_CONFLICT', message: '다른 작업이 먼저 …', isVersionConflict: true });
  });

  it('검증 오류(400)의 메시지 배열은 이어 붙이고, code가 없으면 null', async () => {
    mockApi({ 'POST /scans': () => ({ status: 400, body: { statusCode: 400, message: ['scanId는 …', 'serials는 …'], error: 'Bad Request' } }) });
    const error = (await api('/scans', { method: 'POST', body: {} }).catch((e: unknown) => e)) as ApiError;
    expect([error.status, error.code, error.message, error.isVersionConflict]).toEqual([400, null, 'scanId는 …, serials는 …', false]);
  });
});
