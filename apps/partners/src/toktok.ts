import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendJson } from './http.js';
import type { PartnersState } from './state.js';

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** 골칫거리: 가끔 실패한다. 실패한 요청은 저장하지 않는다(받지 못한 것으로 본다). 응답을 보냈으면 true */
function failed(state: PartnersState, res: ServerResponse): boolean {
  if (!state.chance(state.config.toktok.failRate)) return false;
  state.stats.status5xx += 1;
  sendJson(res, 500, { error: 'TEMPORARY' });
  return true;
}

/**
 * POST /toktok/hooks/:channel  { idempotencyKey, text, attachments?: [fileId] } → 200. 받은 메시지는 중복이어도 모두 저장한다.
 * attachments는 먼저 POST /toktok/files로 올린 파일의 id. 모르는 id가 있으면 400 UNKNOWN_FILE(메시지를 저장하지 않는다).
 */
export async function toktokHook(state: PartnersState, channel: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  state.count('toktok.hook');
  const body = await readJson(req);
  const attachments = body?.attachments ?? [];
  if (!body || typeof body.idempotencyKey !== 'string' || typeof body.text !== 'string' || !Array.isArray(attachments) || attachments.some((a) => typeof a !== 'string')) {
    return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'idempotencyKey, text가 필요합니다(attachments는 파일 id 배열).' });
  }
  const unknown = (attachments as string[]).filter((id) => !state.files.has(id));
  if (unknown.length > 0) return sendJson(res, 400, { error: 'UNKNOWN_FILE', message: `올리지 않은 파일: ${unknown.join(', ')}` });
  if (failed(state, res)) return;
  state.messages.push({
    channel,
    idempotencyKey: body.idempotencyKey,
    text: body.text,
    receivedAt: new Date().toISOString(),
    attachments: (attachments as string[]).map((id) => {
      const f = state.files.get(id)!;
      return { fileId: f.fileId, fileName: f.fileName, size: f.size };
    }),
  });
  sendJson(res, 200, { ok: true });
}

/**
 * POST /toktok/files  { fileName, contentType, contentBase64 } → 201 { fileId, fileName, size }
 * 파일은 JSON 안의 base64로 받는다(multipart가 아니다 — 의존성 없는 node:http 서버에서 multipart를 직접 풀지 않으려고, decisions/0035).
 * 푼 크기가 maxFileBytes를 넘으면 413, base64가 아니면 400.
 */
export async function toktokUpload(state: PartnersState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  state.count('toktok.file');
  const body = await readJson(req);
  const { fileName, contentType, contentBase64 } = (body ?? {}) as Record<string, unknown>;
  if (typeof fileName !== 'string' || !fileName || typeof contentType !== 'string' || typeof contentBase64 !== 'string' || contentBase64.length % 4 !== 0 || !BASE64.test(contentBase64)) {
    return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'fileName, contentType, contentBase64(base64)가 필요합니다.' });
  }
  const content = Buffer.from(contentBase64, 'base64');
  if (content.length > state.config.toktok.maxFileBytes) {
    return sendJson(res, 413, { error: 'FILE_TOO_LARGE', message: `파일은 ${state.config.toktok.maxFileBytes}바이트까지 받습니다.` });
  }
  if (failed(state, res)) return;
  const fileId = `TF${state.nextNumber()}`;
  state.files.set(fileId, { fileId, fileName, contentType, size: content.length, content, uploadedAt: new Date().toISOString() });
  sendJson(res, 201, { fileId, fileName, size: content.length });
}

/** GET /__admin/toktok/files/:fileId → 올린 파일 그대로(테스트가 첨부 내용을 확인한다) */
export function toktokFile(state: PartnersState, fileId: string, res: ServerResponse): void {
  const f = state.files.get(fileId);
  if (!f) return sendJson(res, 404, { error: 'NOT_FOUND' });
  res.writeHead(200, { 'Content-Type': f.contentType, 'Content-Length': String(f.size) });
  res.end(f.content);
}

/** 멱등키별 수신 횟수. 2 이상이면 같은 알림을 두 번 이상 받은 것이다. */
export function toktokSummary(state: PartnersState) {
  const byKey: Record<string, number> = {};
  for (const m of state.messages) byKey[m.idempotencyKey] = (byKey[m.idempotencyKey] ?? 0) + 1;
  return { total: state.messages.length, byKey, messages: state.messages, files: state.files.size };
}
