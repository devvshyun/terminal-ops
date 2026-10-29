import { describe, expect, it } from 'vitest';
import { keys } from './query-keys';

/** 화면·컴포넌트 소스(테스트 제외). 키 글자를 직접 쓰는 곳이 없는지 본다 */
const sources = import.meta.glob(['../**/*.tsx', '../**/*.ts', '!../**/*.test.tsx', '!../**/*.test.ts', '!./query-keys.ts', '!../test/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('쿼리 키 팩토리 (Day 6 최종 리뷰 Minor 4, decisions/0041 Day 7 보탬)', () => {
  it('한 건 키는 그 묶음의 무효화 키로 시작한다(앞부분 무효화가 닿는다)', () => {
    const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) => prefix.every((p, i) => key[i] === p);
    expect(startsWith(keys.terminal.detail('A-1'), keys.terminal.one('A-1'))).toBe(true);
    expect(startsWith(keys.terminal.one('A-1'), keys.terminal.all)).toBe(true);
    expect(startsWith(keys.terminals.page({ status: 'IN_STOCK' }, 2), keys.terminals.all)).toBe(true);
    expect(startsWith(keys.terminals.stock('SN-200'), keys.terminals.all)).toBe(true);
    expect(startsWith(keys.purchaseOrders.open, keys.purchaseOrders.all)).toBe(true);
    expect(startsWith(keys.purchaseOrder.reconciliation('SE0003'), keys.purchaseOrder.all)).toBe(true);
    expect(startsWith(keys.serviceTicket.one(7), keys.serviceTicket.all)).toBe(true);
    expect(startsWith(keys.anomalies.list('OFFLINE_TOO_LONG', 'true'), keys.anomalies.all)).toBe(true);
    expect(startsWith(keys.vanRun.items(3, '', ''), keys.vanRun.all)).toBe(true);
    expect(startsWith(keys.firmware.byModel('SN-100'), keys.firmware.all)).toBe(true);
  });

  it('목록 묶음(복수)과 한 건 묶음(단수)의 첫 칸이 서로 다르다 — 한쪽 무효화가 다른 쪽을 대신하지 않는다는 것을 이름으로 드러낸다', () => {
    expect(keys.terminals.all[0]).not.toBe(keys.terminal.all[0]);
    expect(keys.purchaseOrders.all[0]).not.toBe(keys.purchaseOrder.all[0]);
    expect(keys.serviceTickets.all[0]).not.toBe(keys.serviceTicket.all[0]);
    expect(keys.vanRuns.all[0]).not.toBe(keys.vanRun.all[0]);
  });

  it('화면·컴포넌트는 키 글자를 직접 쓰지 않고 이 파일의 keys만 쓴다', () => {
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(20); // glob이 실제로 소스를 읽었는지
    const offenders = files.filter((f) => /queryKey:\s*\[/.test(sources[f]));
    expect(offenders).toEqual([]);
  });
});
