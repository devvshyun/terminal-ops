import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PartnerTransientError } from '../../src/common/partner-errors.js';
import { partnerFetch } from '../../src/common/partner-http.js';

describe('partnerFetch 본문 읽기', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    // 헤더(200)만 보내고 본문은 보내지 않은 채 멈추는 서버
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.flushHeaders();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it('헤더 뒤 본문이 멈춰 타임아웃이 나면 일시 오류', async () => {
    const error = await partnerFetch('테스트업체', url, {}, 200).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PartnerTransientError);
    expect((error as Error).message).toContain('TimeoutError');
  });
});
