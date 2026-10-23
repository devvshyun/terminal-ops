import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PartnerTransientError } from '../../src/common/partner-errors.js';
import { MAX_RETRY_AFTER_MS, parseRetryAfter, partnerFetch } from '../../src/common/partner-http.js';

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

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-10-23T00:00:00Z');

  it('초 단위와 HTTP 날짜를 ms로 바꾼다', () => {
    expect(parseRetryAfter('2', now)).toBe(2000);
    expect(parseRetryAfter('Fri, 23 Oct 2026 00:00:05 GMT', now)).toBe(5000);
  });

  it('없거나 못 읽으면 1초, 음수는 0', () => {
    expect(parseRetryAfter(null, now)).toBe(1000);
    expect(parseRetryAfter('soon', now)).toBe(1000);
    expect(parseRetryAfter('-3', now)).toBe(0);
  });

  it('60초를 넘으면 60초로 자른다', () => {
    expect(parseRetryAfter('3600', now)).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter('Sat, 24 Oct 2026 00:00:00 GMT', now)).toBe(60_000);
  });
});
