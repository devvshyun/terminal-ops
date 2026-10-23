import { Agent, request } from 'node:http';

export interface ApiResponse {
  status: number;
  body: unknown;
  /** 요청을 보내고 본문을 다 받을 때까지(ms) */
  ms: number;
}

/** 요청 실패. 걸린 시간(ms)과 종류(시간 초과 / 그 밖의 소켓 오류)를 갖는다 */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'network',
    readonly ms: number,
  ) {
    super(message);
  }
}

/**
 * 우리 API로 JSON을 보내는 HTTP 클라이언트. keep-alive 에이전트 하나를 쓰고 소켓 수를 maxSockets로 묶는다.
 * 요청마다 새 연결을 열면 5,000대 실험에서 Windows 임시 포트(TIME_WAIT)가 바닥날 수 있다.
 */
export class ApiClient {
  private readonly agent: Agent;

  constructor(
    private readonly baseUrl: string,
    maxSockets: number,
    private readonly timeoutMs: number,
  ) {
    new URL(baseUrl); // 주소가 틀리면 여기서 바로 던진다(설정을 바꾸는 중이면 이전 설정이 남는다)
    this.agent = new Agent({ keepAlive: true, maxSockets, maxFreeSockets: maxSockets });
  }

  postJson(path: string, body: unknown): Promise<ApiResponse> {
    const url = new URL(path, this.baseUrl);
    const payload = Buffer.from(JSON.stringify(body));
    const started = performance.now();
    return new Promise((resolve, rejectRaw) => {
      let timedOut = false;
      const reject = (error: Error) =>
        rejectRaw(new RequestError(error.message, timedOut ? 'timeout' : 'network', performance.now() - started));
      const req = request(
        url,
        {
          method: 'POST',
          agent: this.agent,
          headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = text;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              // JSON이 아니면 글자 그대로 둔다
            }
            resolve({ status: res.statusCode ?? 0, body: parsed, ms: performance.now() - started });
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => {
        timedOut = true;
        req.destroy(new Error(`요청 시간 초과(${this.timeoutMs}ms)`));
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  close(): void {
    this.agent.destroy();
  }
}
