import type { IncomingMessage, ServerResponse } from 'node:http';

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** JSON 본문을 읽는다. 비었거나 깨졌으면 undefined */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const raw = await readBody(req);
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

export function sendXml(res: ServerResponse, status: number, xml: string): void {
  res.writeHead(status, { 'Content-Type': 'application/xml; charset=utf-8' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>${xml}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
