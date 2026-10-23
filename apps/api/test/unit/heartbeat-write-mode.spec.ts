import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_MYSQL_MODE_WARNING, resolveHeartbeatWriteMode } from '../../src/config/heartbeat-write-mode.js';
import { HeartbeatService } from '../../src/device/heartbeat.service.js';

describe('HEARTBEAT_WRITE_MODE 가드(decisions/0027)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('mysql이 아니면 redis(없음·오타 포함)', () => {
    expect(resolveHeartbeatWriteMode(undefined, 'production')).toBe('redis');
    expect(resolveHeartbeatWriteMode('redis', 'production')).toBe('redis');
    expect(resolveHeartbeatWriteMode('MYSQL', undefined)).toBe('redis');
  });

  it('운영(NODE_ENV=production)에서 mysql이면 시작할 때 던진다', () => {
    expect(() => resolveHeartbeatWriteMode('mysql', 'production')).toThrow(/운영\(NODE_ENV=production\)에서 쓸 수 없습니다/);
  });

  it('운영이 아니면 mysql을 허용한다(실험용)', () => {
    expect(resolveHeartbeatWriteMode('mysql', 'test')).toBe('mysql');
    expect(resolveHeartbeatWriteMode('mysql', undefined)).toBe('mysql');
  });

  it('HeartbeatService는 mysql 모드로 시작하면 경고하고, redis면 조용하다', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const svc = new HeartbeatService({} as never, {} as never);
    svc.onModuleInit();
    expect(warn).not.toHaveBeenCalled();
    svc.writeMode = 'mysql';
    svc.onModuleInit();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(HEARTBEAT_MYSQL_MODE_WARNING);
  });
});
