import { describe, expect, it } from 'vitest';
import { backdateStatements, PAST_DELIVERED_SERIAL, PAST_OFFLINE_SERIAL, PAST_TERMINALS, writePast, type PastWriter } from '../../src/db/scenario-past.js';

/** 시연 데이터의 지난 일(decisions/0090): 시연 단말기 두 대의 시각만 옮기고, 운영에서는 아무것도 쓰지 않는다 */
describe('시연 지난 일', () => {
  const now = new Date('2026-10-30T03:00:00.000Z');
  const recorder = () => {
    const sql: { sql: string; params: unknown[] }[] = [];
    const offline: string[][] = [];
    const writer: PastWriter = {
      execute: async (s, params) => void sql.push({ sql: s, params }),
      markOffline: async (serials) => void offline.push(serials),
    };
    return { sql, offline, writer };
  };

  it('기준일보다 하루 더: 오프라인은 마지막 하트비트 4일 전(기준 3), 배송 완료는 8일 전(기준 7)', () => {
    expect(PAST_TERMINALS).toEqual([
      { serialNo: PAST_OFFLINE_SERIAL, daysAgo: 5, lastSeenDaysAgo: 4 },
      { serialNo: PAST_DELIVERED_SERIAL, daysAgo: 8 },
    ]);
  });

  it('모든 UPDATE는 그 시리얼 하나와 "아직 안 옮김"(status_changed_at > 목표) 조건 — 다시 돌려도 두 번 옮기지 않는다', () => {
    const target = new Date('2026-10-22T03:00:00.000Z');
    const statements = backdateStatements({ serialNo: PAST_DELIVERED_SERIAL, daysAgo: 8 }, now);
    expect(statements).toHaveLength(4);
    for (const s of statements) {
      expect(s.sql).toMatch(/^update /);
      expect(s.sql).toMatch(/where t\.serial_no = \? and t\.status_changed_at > \?$/);
      expect(s.params.slice(-2)).toEqual([PAST_DELIVERED_SERIAL, target]);
    }
    // 단말기 행이 마지막: 앞 문장들이 옮기기 전 status_changed_at과의 차이로 옮긴다
    expect(statements.at(-1)!.sql).toMatch(/^update terminal t set t\.created_at = .*, t\.status_changed_at = \? where/);
  });

  it('오프라인 단말기는 접속 기록(online 0, 마지막 하트비트 4일 전)을 만들고 — 이미 있으면 그대로(insert ignore)', () => {
    const statements = backdateStatements({ serialNo: PAST_OFFLINE_SERIAL, daysAgo: 5, lastSeenDaysAgo: 4 }, now);
    const insert = statements.at(-1)!;
    expect(insert.sql).toMatch(/^insert ignore into device_connectivity/);
    expect(insert.params).toEqual([new Date('2026-10-26T03:00:00.000Z'), '2.0.0', new Date('2026-10-26T03:01:30.000Z'), PAST_OFFLINE_SERIAL]);
  });

  it('쓰기: 두 대의 문장 + Redis 오프라인 기록에 DM-0021', async () => {
    const r = recorder();
    expect(await writePast(r.writer, now, {})).toBe(true);
    expect(r.sql).toHaveLength(4 + 1 + 4);
    expect(new Set(r.sql.map((s) => s.params.at(-1) === PAST_OFFLINE_SERIAL || s.params.at(-2) === PAST_OFFLINE_SERIAL ? 'offline' : 'delivered')).size).toBe(2);
    expect(r.offline).toEqual([[PAST_OFFLINE_SERIAL]]);
  });

  it.each([{ NODE_ENV: 'production' }, { NODE_ENV: 'production', SEED_DEMO: '1' }, { SEED_DEMO: '0' }])('운영·시연 끔(%o)이면 아무것도 쓰지 않는다', async (env) => {
    const r = recorder();
    expect(await writePast(r.writer, now, env)).toBe(false);
    expect(r.sql).toEqual([]);
    expect(r.offline).toEqual([]);
  });
});
