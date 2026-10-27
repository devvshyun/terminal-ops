import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { env } from '../../src/config/env.js';
import { sleep } from './experiment.js';

/** 빌드한 워커 프로세스(npm run build 뒤 apps/api/dist/worker.js) */
export const WORKER_JS = resolve(process.cwd(), 'dist/worker.js');

/**
 * dist/worker.js를 자식 프로세스로 띄우고 "worker ready"가 찍힐 때까지 기다린다(실험 0005의 방식, 실험 0014가 씀).
 * 이 테스트 파일과 같은 큐 접두사(env.queuePrefix)를 써서 이 파일이 넣은 job만 처리한다. 주기 작업은 켜지 않는다.
 * 띄운 프로세스는 바로 workers에 넣는다 — 준비가 실패해도 호출한 쪽 afterAll이 PID로 정리할 수 있게.
 */
export async function startWorker(name: string, workers: ChildProcess[], extraEnv: Record<string, string> = {}): Promise<ChildProcess> {
  const child = spawn(process.execPath, [WORKER_JS], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', QUEUE_PREFIX: env.queuePrefix, WORKER_NAME: name, RUN_SCHEDULERS: '0', ...extraEnv },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  workers.push(child);
  try {
    await new Promise<void>((ready, fail) => {
      const timer = setTimeout(() => fail(new Error(`${name}가 15초 안에 준비되지 않았습니다.`)), 15_000);
      let output = ''; // 'worker ready'가 두 청크에 걸쳐 올 수 있어 누적해서 본다
      child.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('worker ready')) {
          clearTimeout(timer);
          ready();
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        fail(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        fail(new Error(`${name}가 종료됐습니다(exit ${code}).`));
      });
    });
  } catch (error) {
    await stopWorker(child);
    throw error;
  }
  return child;
}

/**
 * 강제 종료: 이 테스트가 띄운 자식 프로세스에만 SIGKILL을 보낸다(child.kill — 그 자식의 PID로 간다. 이름으로 끄지 않는다 — 다른 node가 함께 죽는다).
 * Windows에서는 node가 TerminateProcess로 끝낸다(정리 훅이 돌지 않는다 — BullMQ 잠금도 그대로 남는다). 끝날 때까지 기다린다.
 * `process.kill(pid, 'SIGKILL')`도 같은 일을 하지만 Windows에서는 exit가 code 1·signal null로 보고된다 — 신호로 확인하려고 child.kill을 쓴다(troubleshooting/0028).
 */
export async function killWorker(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  const [code, signal] = (await exited) as [number | null, NodeJS.Signals | null];
  return { code, signal };
}

/** 정상 종료를 먼저 청하고(SIGTERM), timeoutMs 안에 안 끝나면 PID로 강제 종료한다 */
export async function stopWorker(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  const timedOut = await Promise.race([exited.then(() => false), sleep(timeoutMs).then(() => true)]);
  if (timedOut && child.pid !== undefined) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // 이미 끝났다
    }
    await Promise.race([exited, sleep(5_000)]);
  }
}
