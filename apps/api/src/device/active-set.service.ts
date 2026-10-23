import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import { UnrecoverableError } from 'bullmq';
import type { Redis } from 'ioredis';
import { execOrThrow } from '../redis/redis-exec.js';
import { REDIS } from '../redis/redis.provider.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatus } from '../terminal/terminal-status.js';
import { deviceKeys } from './device-keys.js';

/** HSET 한 번에 넣는 필드 수 */
const CHUNK = 1000;

/**
 * 하트비트를 받을 단말기 목록(Redis HASH `hb:active`, serialNo → terminal.id). 원본은 MySQL의 단말기 상태(IN_SERVICE)이고,
 * 이 HASH는 하트비트마다 MySQL을 보지 않으려고 둔 사본이다(decisions/0027·0028).
 */
@Injectable()
export class ActiveSetService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly em: EntityManager,
  ) {}

  /**
   * MySQL의 IN_SERVICE 단말기로 HASH를 통째로 다시 만든다. 임시 키에 다 쓴 뒤 RENAME으로 한 번에 바꾼다 —
   * 만드는 동안 하트비트가 빈 목록을 보지 않는다. 임시 키에는 TTL을 걸어(중간에 죽으면 사라지게) RENAME 직전에 PERSIST한다
   * (RENAME은 원래 키의 TTL을 그대로 가져간다). @returns 단말기 수
   */
  async rebuild(): Promise<number> {
    const rows: { id: number; serialNo: string }[] = await this.em
      .fork()
      .createQueryBuilder(Terminal)
      .select(['id', 'serialNo'])
      .where({ status: TerminalStatus.IN_SERVICE })
      .execute('all');
    const { active } = deviceKeys();
    if (rows.length === 0) {
      await this.redis.del(active);
      return 0;
    }
    const tmp = `${active}:rebuild:${randomUUID()}`;
    const fill = this.redis.pipeline();
    for (let i = 0; i < rows.length; i += CHUNK) {
      fill.hset(tmp, Object.fromEntries(rows.slice(i, i + CHUNK).map((r) => [r.serialNo, String(r.id)])));
    }
    fill.pexpire(tmp, 60_000);
    await execOrThrow(fill);
    await execOrThrow(this.redis.multi().persist(tmp).rename(tmp, active));
    return rows.length;
  }

  /**
   * 몇 대만 MySQL의 **지금** 상태로 맞춘다(Outbox 이벤트 프로젝터가 부른다). 이벤트에 적힌 상태(toStatus)를 쓰지 않고
   * 다시 읽으므로, 같은 단말기의 이벤트가 늦게·뒤바뀐 순서로 와도 결과는 마지막 커밋 상태다. 없는 시리얼은 지운다.
   * 시리얼이 글자가 아니면(이벤트 payload가 깨짐) UnrecoverableError — 몇 번 다시 해도 같으므로 재시도하지 않는다.
   * 그대로 두면 숫자는 조용히 HDEL만 하고 성공으로 끝났다(troubleshooting/0018).
   */
  async apply(serials: unknown[]): Promise<void> {
    const bad = serials.filter((s) => typeof s !== 'string' || s.length === 0);
    if (bad.length > 0) throw new UnrecoverableError(`project: serialNo가 글자가 아닙니다: ${JSON.stringify(bad)}`);
    if (serials.length === 0) return;
    const rows: { id: number; serialNo: string; status: TerminalStatus }[] = await this.em
      .fork()
      .createQueryBuilder(Terminal)
      .select(['id', 'serialNo', 'status'])
      .where({ serialNo: { $in: serials as string[] } })
      .execute('all');
    const inService = rows.filter((r) => r.status === TerminalStatus.IN_SERVICE);
    const gone = (serials as string[]).filter((s) => !inService.some((r) => r.serialNo === s));
    const { active } = deviceKeys();
    const batch = this.redis.pipeline();
    if (inService.length > 0) batch.hset(active, Object.fromEntries(inService.map((r) => [r.serialNo, String(r.id)])));
    if (gone.length > 0) batch.hdel(active, ...gone);
    await execOrThrow(batch);
  }
}
