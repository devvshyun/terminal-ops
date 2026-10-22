import { partnerFetch } from '../common/partner-http.js';

export interface ToktokOptions {
  baseUrl: string;
  channel: string;
  timeoutMs: number;
}

/** 톡톡메신저 웹훅. 같은 idempotencyKey를 다시 보내도 메신저가 한 번으로 보이게 하는 것이 약속이다(가상). */
export class ToktokClient {
  constructor(private readonly opts: ToktokOptions) {}

  async send(message: { idempotencyKey: string; text: string }): Promise<void> {
    await partnerFetch(
      '톡톡메신저',
      `${this.opts.baseUrl}/toktok/hooks/${encodeURIComponent(this.opts.channel)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) },
      this.opts.timeoutMs,
    );
  }
}
