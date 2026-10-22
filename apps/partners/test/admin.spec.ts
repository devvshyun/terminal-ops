import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPartners, type Partners } from './helpers.js';

describe('관리 API 본문 검증', () => {
  let p: Partners;
  const post = (body: string) =>
    fetch(`${p.base}/__admin/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

  beforeAll(async () => {
    p = await startPartners();
  });
  beforeEach(async () => {
    await p.reset();
  });
  afterAll(() => p.close());

  it('깨진 JSON이면 400', async () => {
    expect((await post('{"bungae":')).status).toBe(400);
  });

  it('JSON 객체가 아니면 400', async () => {
    expect((await post('[1,2]')).status).toBe(400);
  });

  it('일부만 담은 올바른 설정은 200', async () => {
    const res = await post('{"toktok":{"failRate":0.5}}');
    expect(res.status).toBe(200);
    expect((await res.json()).toktok.failRate).toBe(0.5);
  });

  it('본문이 비어 있으면 그대로 200', async () => {
    expect((await post('')).status).toBe(200);
  });
});
