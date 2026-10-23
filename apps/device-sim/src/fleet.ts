import { ApiClient, RequestError } from './client.js';
import { defaultConfig, serialsOf, type SimConfig } from './config.js';
import { createRng, hashUniform } from './rng.js';
import { SimStats } from './stats.js';

export interface Device {
  serialNo: string;
  firmwareVersion: string;
  /** 하트비트를 보내지 않는 단말기 */
  offline: boolean;
  /** 펌웨어 업데이트 중(결과를 보고하기 전). 보기용 — 기준은 Fleet의 시리얼별 updating 목록이다 */
  updating: boolean;
}

/** API 하트비트 응답의 업데이트 지시(apps/api HeartbeatService) */
interface UpdateOffer {
  rolloutId: number;
  version: string;
}

/** API 하트비트 응답의 행 하나(apps/api HeartbeatService) */
interface HeartbeatResult {
  serialNo: string;
  result: string;
  update?: UpdateOffer;
}

/** 작업 목록을 동시에 n개까지만 돌린다. shouldStop이 true를 돌려주면 새 작업은 시작하지 않고 하던 작업만 끝낸다. */
export async function runPool<T>(items: T[], n: number, work: (item: T) => Promise<void>, shouldStop: () => boolean = () => false): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length && !shouldStop()) {
      const item = items[next++];
      await work(item);
    }
  });
  await Promise.all(lanes);
}

/** 시드로 정해지는 순서로 섞어 앞에서 k개를 고른다(Fisher–Yates). 같은 시드·같은 목록이면 같은 결과 */
export function pickSeeded<T>(items: T[], k: number, seed: number): T[] {
  const rng = createRng(seed);
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

/**
 * 단말기 무리. 주기마다 온라인 단말기의 하트비트를 batchSize씩 묶어 `POST /devices/heartbeats`로 보낸다
 * (동시 요청은 concurrency까지). 앞 주기가 끝나지 않았으면 그 주기는 건너뛰고 skippedTicks로 센다.
 * 응답에 업데이트 지시가 있으면 updateDelayMs(+ 무작위 0~updateJitterMs) 뒤 결과(firmwareFailRate 확률로 실패)를
 * `POST /devices/firmware-reports`로 보고한다.
 */
export class Fleet {
  config: SimConfig = defaultConfig();
  stats = new SimStats();
  devices = new Map<string, Device>();
  private client: ApiClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inTick: Promise<void> | null = null;
  /** stop이 요청됐다. 새 묶음을 시작하지 않는다. start가 지운다 */
  private stopping = false;
  /** 진행 중인 업데이트(대기 타이머 + 보고 요청) */
  private updates = new Set<Promise<void>>();
  /** 보고를 기다리는 업데이트 타이머 → 그 업데이트를 끝내는 resolve(close가 타이머를 버릴 때 불러 settleUpdates가 멈추지 않게) */
  private updateTimers = new Map<NodeJS.Timeout, () => void>();
  /**
   * 업데이트 중인 단말기(시리얼 → 시작한 세대). Device 객체와 따로 둔다 — configure가 단말기 목록을 새로 만들거나
   * 단말기가 목록에서 빠졌다 다시 들어와도 같은 단말기가 업데이트를 두 번 하지 않게.
   */
  private updating = new Map<string, number>();
  /**
   * 세대. close(reset)가 1 올린다. 보고는 시작할 때의 세대를 들고 가서, 끝났을 때 세대가 바뀌었으면
   * 통계·단말기에 반영하지 않는다(reset 뒤 새 통계에 이전 보고가 섞이지 않게).
   */
  private generation = 0;

  constructor(config: SimConfig = defaultConfig()) {
    this.configure(config);
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /**
   * 설정을 바꾸고 단말기 목록을 다시 만든다. 이미 있던 단말기의 펌웨어는 유지한다.
   * 새 단말기 목록·연결을 모두 만든 뒤에 한꺼번에 바꾼다(중간에 던지면 이전 상태 그대로).
   */
  configure(config: SimConfig): void {
    const serials = serialsOf(config);
    const offline = new Set([...config.offlineSerials, ...pickSeeded(serials, Math.round(serials.length * config.offlineRate), config.seed)]);
    const next = new Map<string, Device>();
    for (const serialNo of serials) {
      const prev = this.devices.get(serialNo);
      next.set(serialNo, {
        serialNo,
        firmwareVersion: prev?.firmwareVersion ?? config.firmwareVersion,
        offline: offline.has(serialNo),
        updating: this.updating.has(serialNo),
      });
    }
    const client = new ApiClient(config.targetUrl, config.concurrency, config.requestTimeoutMs);
    this.client?.close();
    this.client = client;
    this.config = config;
    this.devices = next;
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.stats.startedAt ??= new Date().toISOString();
    this.timer = setInterval(() => void this.tickIfIdle(), this.config.intervalMs);
    void this.tickIfIdle();
  }

  /** 멈춘다. 주기 도중이어도 새 묶음은 보내지 않고, 이미 보낸 요청의 응답(또는 제한 시간)만 기다린다. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      await this.inTick;
    } finally {
      if (this.timer === null) this.stopping = false; // 그 사이 start가 오지 않았으면 직접 tick()도 다시 쓸 수 있다
    }
  }

  /** 진행 중인 업데이트 보고가 모두 끝날 때까지 기다린다(테스트용) */
  async settleUpdates(): Promise<void> {
    while (this.updates.size > 0) await Promise.all([...this.updates]);
  }

  async reset(config: SimConfig = defaultConfig()): Promise<void> {
    await this.close();
    this.devices.clear();
    this.stats = new SimStats();
    this.configure(config);
  }

  /**
   * 멈추고(stop), 보고를 기다리던 업데이트는 버린다. 세대를 올려, 이미 보낸 보고 요청은 끝나도 통계·단말기에 반영하지 않는다
   * (연결을 닫으므로 보통 바로 실패한다). 버린 업데이트는 끝난 것으로 쳐 settleUpdates를 기다리던 쪽도 풀린다.
   * stop()만으로는 업데이트를 버리지 않는다 — 대기 중인 업데이트는 끝까지 가서 보고한다.
   */
  async close(): Promise<void> {
    await this.stop();
    this.generation += 1;
    for (const [timer, resolve] of this.updateTimers) {
      clearTimeout(timer);
      resolve();
    }
    this.updateTimers.clear();
    this.updates.clear();
    this.updating.clear();
    for (const d of this.devices.values()) d.updating = false;
    this.client?.close();
  }

  private async tickIfIdle(): Promise<void> {
    if (this.inTick) {
      this.stats.skippedTicks += 1;
      return;
    }
    this.inTick = this.tick().finally(() => (this.inTick = null));
    await this.inTick;
  }

  /** 한 주기: 온라인 단말기를 batchSize씩 묶어 보낸다. */
  async tick(): Promise<void> {
    this.stats.ticks += 1;
    this.stats.lastTickAt = new Date().toISOString();
    const online = [...this.devices.values()].filter((d) => !d.offline);
    const batches: Device[][] = [];
    for (let i = 0; i < online.length; i += this.config.batchSize) batches.push(online.slice(i, i + this.config.batchSize));
    await runPool(batches, this.config.concurrency, (batch) => this.send(batch), () => this.stopping);
  }

  private async send(batch: Device[]): Promise<void> {
    const client = this.client!;
    this.stats.requests += 1;
    this.stats.heartbeatsSent += batch.length;
    try {
      const res = await client.postJson('/devices/heartbeats', {
        items: batch.map((d) => ({ serialNo: d.serialNo, firmwareVersion: d.firmwareVersion })),
      });
      if (res.status < 200 || res.status >= 300) {
        this.stats.recordLatency(res.ms, false);
        this.stats.errors += 1;
        this.stats.httpErrors += 1;
        return;
      }
      const results = (res.body as { results?: unknown } | null)?.results;
      if (!Array.isArray(results)) {
        this.stats.recordLatency(res.ms, false);
        this.stats.errors += 1;
        this.stats.badResponses += 1;
        return;
      }
      this.stats.recordLatency(res.ms, true);
      for (const r of results as HeartbeatResult[]) {
        if (r?.result === 'OK') this.stats.heartbeatsAccepted += 1;
        else this.stats.heartbeatsRejected += 1;
        if (r?.update) this.startUpdate(r.serialNo, r.update);
      }
    } catch (error) {
      this.stats.errors += 1;
      if (error instanceof RequestError) {
        this.stats.recordLatency(error.ms, false);
        if (error.kind === 'timeout') this.stats.timeouts += 1;
        else this.stats.networkErrors += 1;
      } else {
        // 예상 밖 예외도 실패 응답 시간에 남긴다(latency.count === requests 불변식)
        this.stats.recordLatency(0, false);
        this.stats.networkErrors += 1;
      }
    }
  }

  /**
   * 업데이트 지시: 이미 업데이트 중이거나 이미 그 버전이면 무시한다(성공 보고 직전에 읽힌 하트비트 응답이 지시를 한 번 더 싣고 올 수 있다).
   * updateDelayMs(+ 0~updateJitterMs) 뒤 결과를 보고한다. 지터와 성공 여부는 공유 난수가 아니라 (시드, 시리얼, 배포 id, 버전)의
   * 해시로 정한다 — 공유 난수를 지시 받은 순서대로 쓰면 concurrency > 1에서 묶음 응답이 오는 순서에 따라 단말기별 결과가 달라진다.
   * 그래서 같은 시드면 응답 순서·동시성과 상관없이 단말기마다 같은 결과다(decisions/0009).
   */
  private startUpdate(serialNo: string, offer: UpdateOffer): void {
    const device = this.devices.get(serialNo);
    if (!device || this.updating.has(serialNo) || device.firmwareVersion === offer.version) return;
    const generation = this.generation;
    this.updating.set(serialNo, generation);
    device.updating = true;
    this.stats.updateOffers += 1;
    const { seed, updateJitterMs, firmwareFailRate } = this.config;
    const jitter = Math.floor(hashUniform(seed, 'jitter', serialNo, offer.rolloutId, offer.version) * updateJitterMs);
    const success = !(hashUniform(seed, 'fail', serialNo, offer.rolloutId, offer.version) < firmwareFailRate);
    const work = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.updateTimers.delete(timer);
        void this.report(serialNo, offer, success, generation).finally(resolve);
      }, this.config.updateDelayMs + jitter);
      this.updateTimers.set(timer, resolve);
    });
    this.updates.add(work);
    void work.finally(() => this.updates.delete(work));
  }

  /**
   * 결과 보고. 하트비트 통계(requests·latency·errors)에는 넣지 않는다(응답 시간 통계가 하트비트만의 값이 되게).
   * 결과는 끝난 시점의 단말기 목록에서 시리얼로 찾아 반영한다 — 업데이트 중에 configure가 단말기 목록(객체)을 새로 만들면
   * 시작할 때 잡은 객체는 더 쓰이지 않는다(그 객체를 바꾸면 새 목록의 단말기가 updating인 채로 남는다, troubleshooting/0020).
   * 그사이 close(reset)로 세대가 바뀌었으면 아무것도 반영하지 않는다. 실패 보고(2xx 아님·오류)면 버전은 그대로이고 다시 보내지 않는다
   * (제안이 남아 있으면 다음 하트비트가 지시를 다시 실어 온다).
   */
  private async report(serialNo: string, offer: UpdateOffer, success: boolean, generation: number): Promise<void> {
    const current = () => generation === this.generation;
    let reported = false;
    try {
      // 보고 시점의 연결을 쓴다(그사이 configure가 연결을 바꿨으면 새 연결)
      const res = await this.client!.postJson('/devices/firmware-reports', {
        serialNo,
        rolloutId: offer.rolloutId,
        success,
        version: offer.version,
      });
      if (!current()) return;
      if (res.status < 200 || res.status >= 300) {
        this.stats.reportErrors += 1;
        return;
      }
      reported = true;
      if (success) this.stats.reportsSucceeded += 1;
      else this.stats.reportsFailed += 1;
    } catch {
      if (current()) this.stats.reportErrors += 1;
    } finally {
      if (current()) this.finishUpdate(serialNo, offer, reported && success);
    }
  }

  private finishUpdate(serialNo: string, offer: UpdateOffer, installed: boolean): void {
    this.updating.delete(serialNo);
    const device = this.devices.get(serialNo);
    if (!device) return;
    device.updating = false;
    if (installed) device.firmwareVersion = offer.version;
  }
}
