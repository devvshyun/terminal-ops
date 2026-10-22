import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPartners, type Partners } from './helpers.js';

describe('톡톡메신저 웹훅', () => {
  let p: Partners;
  const send = (body: unknown) =>
    fetch(`${p.base}/toktok/hooks/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const messages = async () => (await fetch(`${p.base}/__admin/toktok/messages`)).json();

  beforeAll(async () => {
    p = await startPartners();
  });
  beforeEach(async () => {
    await p.reset();
  });
  afterAll(() => p.close());

  it('받은 메시지를 중복까지 모두 저장하고 키별로 센다', async () => {
    expect((await send({ idempotencyKey: 'k1', text: '안녕' })).status).toBe(200);
    await send({ idempotencyKey: 'k1', text: '안녕' });
    await send({ idempotencyKey: 'k2', text: '둘' });
    const m = await messages();
    expect(m.total).toBe(3);
    expect(m.byKey).toEqual({ k1: 2, k2: 1 });
    expect(m.messages[0]).toMatchObject({ channel: 'ops', idempotencyKey: 'k1', text: '안녕' });
  });

  it('필드가 빠지면 400', async () => {
    expect((await send({ text: 'x' })).status).toBe(400);
  });

  it('failRate=1이면 500이고 저장하지 않는다', async () => {
    await p.configure({ toktok: { failRate: 1 } });
    expect((await send({ idempotencyKey: 'k1', text: 'x' })).status).toBe(500);
    expect((await messages()).total).toBe(0);
  });
});
