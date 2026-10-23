import type { IncomingMessage, ServerResponse } from 'node:http';

/** 본문이 있는데 JSON 객체가 아닐 때 던진다. 서버가 400으로 바꿔 응답한다. */
export class BadJsonError extends Error {}

/** JSON 본문을 읽는다. 본문이 비었으면 undefined, 깨졌거나 객체가 아니면 BadJsonError */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BadJsonError('본문이 올바른 JSON이 아닙니다.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadJsonError('본문은 JSON 객체여야 합니다.');
  return value as Record<string, unknown>;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
