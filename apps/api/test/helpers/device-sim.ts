import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/** 테스트용 단말기 시뮬레이터 관리 포트(개발용 4020과 겹치지 않게) */
export const TEST_DEVICE_SIM_PORT = 4021;

const simDir = resolve(process.cwd(), '../device-sim');

/** device-sim 응답 시간 요약(apps/device-sim/src/stats.ts LatencyView) */
export interface DeviceSimLatency {
  count: number;
  p50: number;
  p95: number;
  max: number;
  approx: true;
}

/** device-sim 관리 API의 stats(apps/device-sim/src/stats.ts StatsView + running) */
export interface DeviceSimStats {
  running: boolean;
  ticks: number;
  skippedTicks: number;
  requests: number;
  heartbeatsSent: number;
  heartbeatsAccepted: number;
  heartbeatsRejected: number;
  /** = httpErrors + timeouts + networkErrors + badResponses */
  errors: number;
  httpErrors: number;
  timeouts: number;
  networkErrors: number;
  badResponses: number;
  /** 하트비트 요청 응답 시간(성공·실패 모두 / 성공만 / 실패만, 히스토그램 근삿값). 보고 요청은 넣지 않는다 */
  latency: DeviceSimLatency;
  latencyOk: DeviceSimLatency;
  latencyFailed: DeviceSimLatency;
  updateOffers: number;
  reportsSucceeded: number;
  reportsFailed: number;
  reportErrors: number;
}

async function isUp(base: string): Promise<boolean> {
  try {
    return (await fetch(`${base}/__admin/health`, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    return false;
  }
}

/**
 * 단말기 시뮬레이터(apps/device-sim)를 빌드해 자식 프로세스로 띄운다(partners의 globalSetup과 같은 방식).
 * 대부분의 e2e는 API를 직접 부르고, 실제 프로세스가 필요한 곳(연동 확인·실험)만 이것을 쓴다. 끌 때는 이 PID만 끈다.
 */
export async function startDeviceSim(port = TEST_DEVICE_SIM_PORT) {
  const base = `http://127.0.0.1:${port}`;
  if (await isUp(base)) throw new Error(`${base}에 이미 서버가 떠 있습니다. 테스트용 device-sim 포트를 비우고 다시 실행하세요.`);
  const tsc = createRequire(resolve(simDir, 'package.json')).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', resolve(simDir, 'tsconfig.build.json')], { stdio: 'inherit' });
  const child = spawn(process.execPath, [resolve(simDir, 'dist/main.js')], {
    env: { ...process.env, DEVICE_SIM_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const deadline = Date.now() + 10_000;
  while (!(await isUp(base))) {
    if (child.exitCode !== null) throw new Error(`device-sim이 시작하자마자 종료됐습니다(exit ${child.exitCode}).`);
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('device-sim이 10초 안에 뜨지 않았습니다.');
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`device-sim ${method} ${path} → ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  return {
    base,
    pid: child.pid,
    configure: (patch: Record<string, unknown>) => call<Record<string, unknown>>('POST', '/__admin/config', patch),
    start: () => call<unknown>('POST', '/__admin/start'),
    stop: () => call<unknown>('POST', '/__admin/stop'),
    reset: () => call<unknown>('POST', '/__admin/reset'),
    stats: () => call<DeviceSimStats>('GET', '/__admin/stats'),
    device: (serialNo: string) => call<{ serialNo: string; firmwareVersion: string; offline: boolean; updating: boolean }>('GET', `/__admin/devices/${serialNo}`),
    /** 자식 프로세스(이 PID)만 끈다 */
    close: async () => {
      if (child.exitCode === null) {
        child.kill();
        await once(child, 'exit');
      }
    },
  };
}

export type DeviceSim = Awaited<ReturnType<typeof startDeviceSim>>;
