import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { loginAs, mockApi, renderApp } from '../test/render';
import openapi from '../test/openapi.json';

describe('연동 문서 화면 (보강 7, decisions/0083)', () => {
  it('openapi.json의 경로마다 메서드·경로·범위·쿼리·응답 필드·오류, curl 예(키 자리는 <키>)', async () => {
    const { calls } = mockApi({ 'GET /partner/v1/openapi.json': () => ({ body: openapi }) });
    loginAs();
    renderApp('/docs');
    expect(await screen.findByRole('heading', { name: '단말온 외부 연동 API' })).toBeInTheDocument();
    const ops = screen.getAllByRole('article');
    expect(ops).toHaveLength(2);
    const first = ops[0];
    expect(within(first).getByRole('heading', { name: 'GET /partner/v1/terminals/{serialNo}' })).toBeInTheDocument();
    expect(first).toHaveTextContent('단말기 한 대의 상태');
    expect(first).toHaveTextContent('terminal-status:read');
    expect(within(first).getByRole('table', { name: '응답 필드' })).toHaveTextContent('merchantCode');
    expect(first).toHaveTextContent('401');
    expect(within(first).getByText(/curl/)).toHaveTextContent("curl -H 'Authorization: Bearer <키>'");
    expect(ops[1]).toHaveTextContent('size');
    expect(calls.map((c) => c.path)).toEqual(['/partner/v1/openapi.json']);
  });
});
