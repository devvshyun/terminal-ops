import { describe, expect, it } from 'vitest';
import { recentCount } from '../../src/ops/queue-metrics.js';
import { workerNameOf } from '../../src/ops/ops-queues.service.js';

const MIN = 60_000;
/** 10:00:30 UTC 같은 분 안의 한 시각 */
const at = (minute: number, sec = 30) => Date.UTC(2026, 9, 29, 1, minute, sec);

describe('최근 N분 처리량 — BullMQ 분 단위 metrics 읽기 (decisions/0071)', () => {
  it('기록이 없으면(prevTS 0) null — 워커가 metrics를 켜지 않았거나 아직 끝난 job이 없다', () => {
    expect(recentCount({ meta: { count: 0, prevTS: 0, prevCount: 0 }, data: [] }, at(10), 15)).toBeNull();
  });

  it('마지막 갱신 분의 수는 data가 아니라 count − prevCount다(같은 분에 2개 끝남: data [], count 2 — 사전 검증)', () => {
    expect(recentCount({ meta: { count: 2, prevTS: at(10, 5), prevCount: 0 }, data: [] }, at(10, 50), 15)).toBe(2);
  });

  it('data[i]는 마지막 갱신 분보다 i+1분 앞 — 창(지금 분 포함 15분) 안의 칸만 더한다', () => {
    // 마지막 갱신 10분(그 분 3개), 앞으로 9분 4개, 8분 0개, 7분 5개, … 지금 12분이면 창은 −2분~12분
    const m = { meta: { count: 100, prevTS: at(10), prevCount: 97 }, data: [4, 0, 5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 7, 9] };
    // 10분 3 + 9분 4 + 8분 0 + 7분 5 + 6~0분 7칸×1 + −1분(data[10]) 1 + −2분(data[11]) 1 = 21, −3분(data[12]=7)부터 창 밖
    expect(recentCount(m, at(12), 15)).toBe(3 + 4 + 0 + 5 + 7 + 1 + 1);
  });

  it('한동안 끝난 job이 없으면 data가 그때에 멈춰 있다 — 창 밖의 오래된 수는 세지 않는다', () => {
    const m = { meta: { count: 10, prevTS: at(10), prevCount: 4 }, data: [3, 1] };
    expect(recentCount(m, at(10) + 30 * MIN, 15)).toBe(0);
    // 마지막 갱신 분이 창 맨 앞이면 그 분만
    expect(recentCount(m, at(10) + 14 * MIN, 15)).toBe(6);
  });
});

describe('워커 이름 — BullMQ getWorkers()의 rawname에서', () => {
  it('`<접두사>:<큐 base64>:w:<이름>`의 이름, 이름 없이 뜬 워커는 null', () => {
    expect(workerNameOf('test-probe:cHE=:w:pid-123')).toBe('pid-123');
    expect(workerNameOf('terminal-ops:b3V0Ym94:w:worker-a')).toBe('worker-a');
    expect(workerNameOf('terminal-ops:b3V0Ym94')).toBeNull();
    expect(workerNameOf(undefined)).toBeNull();
  });
});
