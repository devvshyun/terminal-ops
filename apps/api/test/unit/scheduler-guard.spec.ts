import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { SchedulerService } from '../../src/scheduler/scheduler.service.js';

describe('SchedulerService — 주입하지 않은 큐', () => {
  it('JOB_SCHEDULERS가 가리키는 큐가 주입되지 않았으면 큐 이름을 담은 오류를 던진다(undefined 접근 TypeError가 아니라)', async () => {
    const fake = { upsertJobScheduler: vi.fn(async () => undefined) } as unknown as Queue;
    const service = new SchedulerService(fake, fake, undefined as unknown as Queue);
    await expect(service.onApplicationBootstrap()).rejects.toThrow(/주입되지 않은 큐: device/);
  });
});
