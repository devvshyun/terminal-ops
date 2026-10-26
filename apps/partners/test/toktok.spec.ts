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

  describe('파일 올리기와 메시지 첨부 (decisions/0035)', () => {
    const upload = (body: unknown) =>
      fetch(`${p.base}/toktok/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10]);
    const file = { fileName: '단말온-주간리포트-2026-10-19.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: bytes.toString('base64') };

    it('base64 JSON으로 올리면 fileId와 푼 크기를 주고, 메시지에 첨부하면 수신 기록에 이름·크기가 남는다. 관리 API로 내용을 그대로 받는다', async () => {
      const res = await upload(file);
      expect(res.status).toBe(201);
      const up = await res.json();
      expect(up).toEqual({ fileId: expect.stringMatching(/^TF\d+$/), fileName: file.fileName, size: 7 });
      expect((await send({ idempotencyKey: 'weekly-report-2026-10-19', text: '주간 리포트', attachments: [up.fileId] })).status).toBe(200);
      const m = await messages();
      expect(m.files).toBe(1);
      expect(m.messages[0].attachments).toEqual([{ fileId: up.fileId, fileName: file.fileName, size: 7 }]);
      const back = await fetch(`${p.base}/__admin/toktok/files/${up.fileId}`);
      expect(back.headers.get('content-type')).toBe(file.contentType);
      expect(Buffer.from(await back.arrayBuffer())).toEqual(bytes);
      expect((await p.stats()).calls).toMatchObject({ 'toktok.file': 1, 'toktok.hook': 1 });
    });

    it('첨부 없는 메시지는 attachments가 빈 배열, 올리지 않은 fileId를 첨부하면 400 UNKNOWN_FILE(저장 안 함)', async () => {
      await send({ idempotencyKey: 'k1', text: '그냥 알림' });
      expect((await messages()).messages[0].attachments).toEqual([]);
      const bad = await send({ idempotencyKey: 'k2', text: 'x', attachments: ['TF-NOPE'] });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toBe('UNKNOWN_FILE');
      expect((await messages()).total).toBe(1);
    });

    it('base64가 아니거나 필드가 빠지면 400, 너무 크면 413, failRate=1이면 500이고 저장하지 않는다', async () => {
      expect((await upload({ ...file, contentBase64: '***' })).status).toBe(400);
      expect((await upload({ fileName: 'a.xlsx' })).status).toBe(400);
      await p.configure({ toktok: { maxFileBytes: 4 } });
      const big = await upload(file);
      expect(big.status).toBe(413);
      expect((await big.json()).error).toBe('FILE_TOO_LARGE');
      await p.configure({ toktok: { maxFileBytes: 1024, failRate: 1 } });
      expect((await upload(file)).status).toBe(500);
      expect((await messages()).files).toBe(0);
    });

    it('Task 8 리뷰: hookFailRate=1이면 파일 올리기는 되고 메시지(웹훅)만 500 — "메시지 단계 실패" 장면', async () => {
      await p.configure({ toktok: { hookFailRate: 1 } });
      const res = await upload(file);
      expect(res.status).toBe(201);
      const { fileId } = await res.json();
      expect((await send({ idempotencyKey: 'k1', text: 'x', attachments: [fileId] })).status).toBe(500);
      expect(await messages()).toMatchObject({ total: 0, files: 1 });
    });
  });
});
