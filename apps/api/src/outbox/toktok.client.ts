import { PartnerPermanentError } from '../common/partner-errors.js';
import { partnerFetch } from '../common/partner-http.js';

export interface ToktokOptions {
  baseUrl: string;
  channel: string;
  timeoutMs: number;
}

/** 메시지에 붙인 fileId를 메신저가 모른다(400 UNKNOWN_FILE). 저장해 둔 fileId가 낡았으면 다시 올리면 된다(Task 8 리뷰) */
export class ToktokUnknownFileError extends PartnerPermanentError {}

/** 톡톡메신저 웹훅. 같은 idempotencyKey를 다시 보내도 메신저가 한 번으로 보이게 하는 것이 약속이다(가상). */
export class ToktokClient {
  constructor(private readonly opts: ToktokOptions) {}

  /** 메시지. attachments는 uploadFile이 준 fileId들 */
  async send(message: { idempotencyKey: string; text: string; attachments?: string[] }): Promise<void> {
    try {
      await partnerFetch(
        '톡톡메신저',
        `${this.opts.baseUrl}/toktok/hooks/${encodeURIComponent(this.opts.channel)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) },
        this.opts.timeoutMs,
      );
    } catch (error) {
      // partnerFetch는 상태와 본문 앞부분을 메시지에 담는다: `톡톡메신저 응답 400: {"error":"UNKNOWN_FILE",…}`
      if (error instanceof PartnerPermanentError && /응답 400: .*"UNKNOWN_FILE"/.test(error.message)) throw new ToktokUnknownFileError(error.message);
      throw error;
    }
  }

  /** 첨부할 파일을 올린다(JSON 안의 base64, decisions/0035). @returns 메시지에 붙일 fileId와 메신저가 받은 크기 */
  async uploadFile(file: { fileName: string; contentType: string; content: Buffer }): Promise<{ fileId: string; size: number }> {
    const text = await partnerFetch(
      '톡톡메신저 파일',
      `${this.opts.baseUrl}/toktok/files`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.fileName, contentType: file.contentType, contentBase64: file.content.toString('base64') }),
      },
      this.opts.timeoutMs,
    );
    let body: { fileId?: unknown; size?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      throw new PartnerPermanentError('톡톡메신저 파일 응답이 JSON이 아닙니다.');
    }
    if (typeof body.fileId !== 'string' || typeof body.size !== 'number') throw new PartnerPermanentError('톡톡메신저 파일 응답 형식이 아닙니다(fileId, size).');
    return { fileId: body.fileId, size: body.size };
  }
}
