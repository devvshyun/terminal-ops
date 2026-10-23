import { ApiClient } from './client.js';
import { defaultConfig, serialsOf, type SimConfig } from './config.js';
import { createRng } from './rng.js';
import { SimStats } from './stats.js';

export interface Device {
  serialNo: string;
  firmwareVersion: string;
  /** 하트비트를 보내지 않는 단말기 */
  offline: boolean;
}

/** API 하트비트 응답의 행 하나(apps/api HeartbeatService) */
interface HeartbeatResult {
  serialNo: string;
  result: string;
}

/** 작업 목록을 동시에 n개까지만 돌린다. */
export async function runPool<T>(items: T[], n: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
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
 */
export class Fleet {
  config: SimConfig = defaultConfig();
  stats = new SimStats();
  devices = new Map<string, Device>();
  private client: ApiClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inTick: Promise<void> | null = null;

  constructor(config: SimConfig = defaultConfig()) {
    this.configure(config);
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** 설정을 바꾸고 단말기 목록을 다시 만든다. 이미 있던 단말기의 펌웨어는 유지한다. */
  configure(config: SimConfig): void {
    this.config = config;
    const serials = serialsOf(config);
    const offline = new Set([...config.offlineSerials, ...pickSeeded(serials, Math.round(serials.length * config.offlineRate), config.seed)]);
    const next = new Map<string, Device>();
    for (const serialNo of serials) {
      const prev = this.devices.get(serialNo);
      next.set(serialNo, { serialNo, firmwareVersion: prev?.firmwareVersion ?? config.firmwareVersion, offline: offline.has(serialNo) });
    }
    this.devices = next;
    this.client?.close();
    this.client = new ApiClient(config.targetUrl, config.concurrency, config.requestTimeoutMs);
  }

  start(): void {
    if (this.timer) return;
    this.stats.startedAt ??= new Date().toISOString();
    this.timer = setInterval(() => void this.tickIfIdle(), this.config.intervalMs);
    void this.tickIfIdle();
  }

  /** 멈추고, 보내는 중인 주기가 끝날 때까지 기다린다. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inTick;
  }

  async reset(config: SimConfig = defaultConfig()): Promise<void> {
    await this.stop();
    this.devices.clear();
    this.stats = new SimStats();
    this.configure(config);
  }

  async close(): Promise<void> {
    await this.stop();
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
    await runPool(batches, this.config.concurrency, (batch) => this.send(batch));
  }

  private async send(batch: Device[]): Promise<void> {
    const client = this.client!;
    this.stats.requests += 1;
    this.stats.heartbeatsSent += batch.length;
    try {
      const res = await client.postJson('/devices/heartbeats', {
        items: batch.map((d) => ({ serialNo: d.serialNo, firmwareVersion: d.firmwareVersion })),
      });
      this.stats.recordLatency(res.ms);
      if (res.status < 200 || res.status >= 300) {
        this.stats.errors += 1;
        return;
      }
      const results = (res.body as { results?: HeartbeatResult[] } | null)?.results ?? [];
      for (const r of results) {
        if (r.result === 'OK') this.stats.heartbeatsAccepted += 1;
        else this.stats.heartbeatsRejected += 1;
      }
    } catch {
      this.stats.errors += 1;
    }
  }
}
