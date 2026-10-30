/**
 * 녹화 재생 엔진(보강 11, decisions/0094). 시연 묶음에서 실제로 받은 응답을 "녹화 시계" 하나로 다시 낸다.
 * - 시계(c, 녹화 시작부터 ms)는 다음 실행 시각에서 멈춰 있다가, 그 실행 단추를 누르면 그 시각으로 옮겨 다음 실행 앞까지 배속으로 흐른다.
 *   그래서 기다리는 단계(배송 완료 52초, 오프라인 판정 96초)는 빨리 감기로 보이고, 실행 사이의 다른 화면 일(현장 스캔·점주 접수)도 저절로 지나간다.
 * - GET은 "그 경로의 응답 가운데 t ≤ c인 마지막 것"(없으면 가장 이른 것). 녹화할 때 같은 경로는 본문이 바뀔 때만 남겼다.
 * - 실행 하나(단추를 누른 때 t ~ 끝난 때 end) 안에서는 요청이 녹화 순서대로 온다: GET이 아닌 요청은 그 실행에 녹화된 같은 방법·경로의 응답을
 *   차례로 꺼내 쓰고, 그 사이의 GET은 "다음 GET이 아닌 요청 바로 앞" 시각으로 답한다(재고 고르기 → 등록 → 출고처럼 읽고 쓰기가 섞여도 녹화 때와 같은 값을 읽는다).
 *   실행이 끝나면(endRun) 시계는 end — 녹화기가 끝난 뒤 결과 패널이 다시 읽을 때까지 기다렸다가 end를 적었다.
 * React·브라우저를 모른다(시각은 밖에서 받는다) — 테스트가 시계를 직접 돌린다.
 */
export interface RecordedResponse {
  /** 녹화 시작부터 ms */
  t: number;
  method: string;
  /** '/api/...' (출처 없이, 쿼리 포함) */
  url: string;
  status: number;
  body: unknown;
}

export interface RecordedRun {
  step: string;
  /** 실행 단추 글자(Run의 label) */
  label: string;
  /** 단추를 누른 때 */
  t: number;
  /** 실행이 끝나고 결과 패널이 다시 읽은 뒤 */
  end: number;
}

export interface RecordedShot {
  /** 화면 열기 단추를 가리키는 이름(app + path) */
  key: string;
  file: string;
  title: string;
  t: number;
}

export interface Recording {
  version: 1;
  recordedAt: string;
  commit: string;
  durationMs: number;
  runs: RecordedRun[];
  responses: RecordedResponse[];
  shots: RecordedShot[];
}

export interface ReplayReply {
  status: number;
  body: unknown;
}

/** 녹화에 없는 요청·이미 쓴 실행 — 앱의 오류 상자가 그대로 보인다 */
export const NOT_RECORDED = 599;

export class Replay {
  private clock = 0;
  /** 실제 시각(ms) 기준점 — clock이 이 순간의 값 */
  private realAt: number;
  private pauseAt: number;
  /** 지금 진행 중인 실행과, 그 실행에 녹화된 GET이 아닌 응답(아직 안 쓴 것) */
  private active: { run: RecordedRun; pending: number[] } | null = null;
  private readonly usedRuns = new Set<number>();
  private readonly byUrl = new Map<string, number[]>();

  constructor(
    readonly recording: Recording,
    private readonly now: () => number,
    readonly speed = 8,
  ) {
    recording.responses.forEach((r, i) => {
      if (r.method !== 'GET') return;
      const list = this.byUrl.get(r.url) ?? [];
      list.push(i);
      this.byUrl.set(r.url, list);
    });
    this.realAt = now();
    this.pauseAt = this.nextRunAfter(-1);
  }

  /** 지금 녹화 시계(ms). 실행 중이 아니면 배속으로 흐르되 다음 실행 시각을 넘지 않는다 */
  time(): number {
    const real = this.now();
    if (!this.active) this.clock = Math.min(this.pauseAt, this.clock + (real - this.realAt) * this.speed);
    this.realAt = real;
    return this.clock;
  }

  /** 다음 실행을 기다리며 멈춰 있나 */
  waiting(): boolean {
    return !this.active && this.time() >= this.pauseAt;
  }

  /** 처음 상태로 */
  reset(): void {
    this.clock = 0;
    this.realAt = this.now();
    this.active = null;
    this.usedRuns.clear();
    this.pauseAt = this.nextRunAfter(-1);
  }

  /**
   * 실행 단추를 눌렀다. 녹화에서 같은 단계·글자의 아직 안 쓴 실행을 찾아 시계를 그 시각으로 옮긴다.
   * 없으면 false — 녹화본에서는 한 실행을 녹화한 횟수만큼만 누를 수 있다.
   */
  startRun(step: string, label: string): boolean {
    const i = this.recording.runs.findIndex((r, idx) => !this.usedRuns.has(idx) && r.step === step && r.label === label);
    if (i < 0) return false;
    this.usedRuns.add(i);
    const run = this.recording.runs[i]!;
    const pending = this.recording.responses.flatMap((r, idx) => (r.method !== 'GET' && r.t >= run.t && r.t <= run.end ? [idx] : []));
    this.active = { run, pending };
    this.clock = run.t;
    this.realAt = this.now();
    this.pauseAt = this.nextRunAfter(i);
    return true;
  }

  /** 실행이 끝났다(성공·실패 모두) — 시계를 그 실행이 끝난 때로 */
  endRun(): void {
    if (!this.active) return;
    this.clock = this.active.run.end;
    this.realAt = this.now();
    this.active = null;
  }

  reply(method: string, url: string): ReplayReply {
    if (method === 'GET') {
      const list = this.byUrl.get(url);
      if (!list) return missing(method, url);
      const at = this.readAt();
      let pick = list[0]!;
      for (const i of list) if (this.recording.responses[i]!.t <= at) pick = i;
      const r = this.recording.responses[pick]!;
      return { status: r.status, body: r.body };
    }
    if (!this.active) return missing(method, url);
    const k = this.active.pending.findIndex((idx) => this.recording.responses[idx]!.method === method && this.recording.responses[idx]!.url === url);
    if (k < 0) return missing(method, url);
    const [idx] = this.active.pending.splice(k, 1);
    const r = this.recording.responses[idx!]!;
    this.clock = r.t;
    return { status: r.status, body: r.body };
  }

  /** 그 화면 열기의 사진 가운데 지금 시각 이전의 마지막 것(없으면 가장 이른 것) */
  shot(key: string): RecordedShot | null {
    const c = this.time();
    const list = this.recording.shots.filter((s) => s.key === key);
    if (list.length === 0) return null;
    return list.filter((s) => s.t <= c).at(-1) ?? list[0]!;
  }

  /** GET이 읽는 시각: 실행 중이면 다음 GET이 아닌 요청 바로 앞(없으면 그 실행의 끝), 아니면 시계 */
  private readAt(): number {
    if (!this.active) return this.time();
    const next = this.active.pending[0];
    return next === undefined ? this.active.run.end : this.recording.responses[next]!.t - 1;
  }

  /** 녹화 순서로 i번째 실행 뒤의 첫 실행 시각(없으면 녹화 끝) */
  private nextRunAfter(i: number): number {
    const at = i < 0 ? -1 : this.recording.runs[i]!.t;
    const next = this.recording.runs.find((r, idx) => idx > i && r.t > at);
    return next ? next.t : this.recording.durationMs;
  }
}

function missing(method: string, url: string): ReplayReply {
  return { status: NOT_RECORDED, body: { message: `녹화본에 없는 요청입니다(${method} ${url}). 녹화본은 녹화한 순서대로만 다시 낼 수 있습니다. 위의 "처음 상태로"로 되돌리세요.` } };
}
