import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { TerminalStatus } from '../../src/terminal/terminal-status.js';
import { classify, serialKey, type OurSide, type VanSide } from '../../src/van/van-compare.js';
import { VanReconciliationItem, VanRunStatus, VanRunTrigger, type VanStatus } from '../../src/van/van.entities.js';
import { VanReconciliationService } from '../../src/van/van-reconciliation.service.js';
import { partners, type VanSeed } from '../helpers/partners.js';
import { captureQueries } from '../helpers/query-log.js';
import { insertTerminals } from '../helpers/terminals.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

/**
 * 실험 0012: VAN 등록 대조 — 등록 5만 건, 어긋남 2%.
 * A. 기본: 수집·비교·재검증 시간, 쿼리 수, 업체 호출 수, 심은 어긋남을 모두 찾는가
 * B. 스캔 도중 변경(페이지마다 이미 지나간 등록 EXP_MUTATE건이 바뀜): 비교 후보 중 재검증이 걸러 낸 거짓 양성 수, 놓친 수
 * C. B 바로 뒤 변경 없이 한 번 더: B가 놓친(지나간 자리에서 새로 생긴) 어긋남을 찾는가
 * 기대값은 숫자를 박지 않고 "심은 어긋남"과 "실행 뒤 VAN의 실제 상태로 계산한 정답"에서 끌어낸다(정답 = 모든 시리얼에 classify).
 * 재현: EXPERIMENTS=1 npx vitest run test/experiments/van-reconciliation.spec.ts --silent=false
 * 규모 바꾸기: EXP_VAN=50000, EXP_MISMATCH=0.02, EXP_MUTATE=10. 끝나면 테스트 DB를 resetDatabase로 다시 만든다.
 */
const N = Number(process.env.EXP_VAN ?? 50_000);
const EVERY = Math.round(1 / Number(process.env.EXP_MISMATCH ?? 0.02)); // 50대에 1대 어긋남
const MUTATE = Number(process.env.EXP_MUTATE ?? 10);
const MERCHANTS = ['GANGNAM-KIMBAP', 'YEOKSAM-CAFE', 'PANGYO-BUNSIK'];
const pad = (i: number) => String(i).padStart(7, '0');
const serial = (i: number) => `VZ-${String(i).padStart(6, '0')}`;

/**
 * 우리 DB 목록에서 VAN 등록을 만든다. EVERY대마다 하나씩 네 종류의 어긋남을 돌아가며 심는다.
 * 미등록(등록 없음)·가맹점 다름·정지는 우리 단말기에, 운영 아님은 우리 DB에 없는 시리얼(VZ-X…)로. 종류마다 절반에 healTo(스캔 도중 변경이 고르면 풀림).
 * 계획과 다름: 계획은 "짝수 번째 어긋남(k % 2 = 0)"에 healTo를 붙였는데, 종류가 k % 4로 돌아 짝수 k는 미등록(등록이 없어 못 붙음)·정지뿐이라
 * healTo가 정지에만 붙었다(첫 실행에서 확인). 네 개씩 한 바퀴를 단위로 번갈아(floor(k / 4) % 2 = 0) 종류마다 절반에 붙인다.
 * 계획과 다름: 운영 아님 등록의 tid를 `T<i>X`로 둔다(계획은 `TX<i>`) — VAN 목록은 tid 오름차순이라 `TX…`는 모두 맨 끝 페이지 뒤에 몰려
 * "이미 지나간 자리"가 되지 못해 스캔 도중 변경이 한 번도 고르지 못한다. `T<i>X`는 원래 단말기 바로 뒤에 끼어 고르게 퍼진다.
 */
function buildVan(): { regs: VanSeed[]; planted: Set<string> } {
  const regs: VanSeed[] = [];
  const planted = new Set<string>();
  let k = 0;
  for (let i = 1; i <= N; i++) {
    const merchantCode = MERCHANTS[i % 3];
    const base: VanSeed = { tid: `T${pad(i)}`, serialNo: serial(i), merchantCode, status: 'ACTIVE' };
    if (i % EVERY !== 0) {
      regs.push(base);
      continue;
    }
    const heal = Math.floor(k / 4) % 2 === 0;
    switch (k++ % 4) {
      case 0: // 미등록: VAN에 없음(heal 없음 — 없는 등록은 바뀔 수 없다)
        planted.add(serial(i));
        break;
      case 1: // 가맹점 다름
        regs.push({ ...base, merchantCode: MERCHANTS[(i + 1) % 3], ...(heal ? { healTo: { merchantCode } } : {}) });
        planted.add(serial(i));
        break;
      case 2: // 정지
        regs.push({ ...base, status: 'SUSPENDED', ...(heal ? { healTo: { status: 'ACTIVE' } } : {}) });
        planted.add(serial(i));
        break;
      case 3: {
        // 운영 아님: 우리 DB에 없는 시리얼이 VAN에 ACTIVE
        const x = `VZ-X${String(i).padStart(6, '0')}`;
        regs.push(base);
        regs.push({ tid: `T${pad(i)}X`, serialNo: x, merchantCode, status: 'ACTIVE', ...(heal ? { healTo: { status: 'CANCELLED' } } : {}) });
        planted.add(x);
        break;
      }
    }
  }
  return { regs, planted };
}

/** 지금 VAN 전체(변경 없이 읽는다 — 호출 전에 mutateDuringScan을 0으로). limit을 바꾸면 수집의 HTTP·JSON만 따로 잴 수 있다 */
async function vanNow(limit = 1000): Promise<Map<string, VanSide>> {
  const out = new Map<string, VanSide>();
  let cursor: string | null = null;
  do {
    const url = new URL('/bridgevan/v1/terminals', env.partnersUrl);
    url.searchParams.set('limit', String(limit));
    if (cursor) url.searchParams.set('cursor', cursor);
    const page = (await (await fetch(url)).json()) as { items: { serialNo: string; status: VanStatus; merchantCode: string }[]; nextCursor: string | null };
    for (const r of page.items) out.set(serialKey(r.serialNo), { status: r.status, merchantCode: r.merchantCode });
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

describe(`실험 0012 — VAN 대조 (등록 ${N}건, ${EVERY}대에 1대 어긋남, 변경 ${MUTATE}건/페이지)`, () => {
  let t: TestApp;
  let svc: VanReconciliationService;
  let van: ReturnType<typeof buildVan>;
  /** 우리 쪽(실험 동안 바뀌지 않는다) */
  const ours = new Map<string, OurSide>();

  /** 정답: 지금 VAN과 우리 쪽에 classify를 돌려 어긋난 시리얼 집합 */
  async function truth(): Promise<Set<string>> {
    await partners.configure({ bridgevan: { mutateDuringScan: 0 } });
    const vans = await vanNow();
    const out = new Set<string>();
    for (const key of new Set([...ours.keys(), ...vans.keys()])) if (classify(ours.get(key) ?? null, vans.get(key) ?? null)) out.add(key);
    return out;
  }

  async function runOnce(label: string) {
    const before = await partners.stats();
    const cap = captureQueries(t.orm);
    const started = performance.now();
    let run;
    try {
      run = await svc.execute((await svc.start(VanRunTrigger.MANUAL, 'exp12')).id);
    } finally {
      cap.stop();
    }
    const ms = Math.round(performance.now() - started);
    const after = await partners.stats();
    const calls = (after.calls['bridgevan.list'] ?? 0) - (before.calls['bridgevan.list'] ?? 0);
    const kinds = (re: RegExp) => cap.queries.filter((q) => re.test(q)).length;
    /** 그 종류 쿼리의 DB 왕복 시간 합(ms) */
    const dbMs = (re: RegExp) => cap.queries.reduce((sum, q, i) => sum + (re.test(q) ? cap.took[i] : 0), 0);
    const phase = { collect: 0, compare: 0, reverify: 0, ...(run.phaseMs ?? {}) };
    const items = await t.orm.em.fork().find(VanReconciliationItem, { run: run.id }, { fields: ['serialNo', 'verified', 'reason'] });
    const row = {
      label,
      status: run.status,
      ms,
      collect: phase.collect,
      compare: phase.compare,
      reverify: phase.reverify,
      other: ms - phase.collect - phase.compare - phase.reverify,
      pages: run.pages,
      fetched: run.fetched,
      vanCalls: calls,
      lookups: calls - run.pages - run.retries,
      retries: run.retries,
      candidates: run.candidates,
      confirmed: run.confirmed,
      resolved: run.resolved,
      unverifiable: run.unverifiable,
      queries: cap.queries.length,
      select: kinds(/^select /i),
      insert: kinds(/^insert /i),
      update: kinds(/^update /i),
      delete: kinds(/^delete /i),
      txn: kinds(/^(begin|start transaction|commit|rollback)/i),
      dbMs: dbMs(/./),
      snapInsertMs: dbMs(/^insert into `van_registration_snapshot`/i),
      snapSelectMs: dbMs(/^select serial_no, status, van_updated_at from van_registration_snapshot/i),
      heartbeatMs: dbMs(/^update `van_reconciliation_run` set `heartbeat_at`/i),
      mutated: after.vanMutated - before.vanMutated,
      healed: after.vanHealed - before.vanHealed,
      counts: JSON.stringify(run.counts),
    };
    return {
      row,
      error: run.error,
      verifiedSet: new Set(items.filter((it) => it.verified).map((it) => serialKey(it.serialNo))),
      candidateSet: new Set(items.map((it) => serialKey(it.serialNo))),
    };
  }

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    svc = t.app.get(VanReconciliationService);
    const started = performance.now();
    const seeds = Array.from({ length: N }, (_, k) => ({ serialNo: serial(k + 1), status: TerminalStatus.IN_SERVICE, merchantCode: MERCHANTS[(k + 1) % 3] }));
    await insertTerminals(t, seeds);
    for (const s of seeds) ours.set(serialKey(s.serialNo), { status: s.status, merchantCode: s.merchantCode });
    van = buildVan();
    console.log(
      `[실험 0012] 준비 ${Math.round(performance.now() - started)}ms: 단말기 ${N}, VAN 등록 ${van.regs.length}, 심은 어긋남 ${van.planted.size}, ` +
        `페이지 ${env.bridgevanPageSize}건, 재검증 동시 ${env.vanReverifyConcurrency}, 후보 상한 max(${env.vanCandidateAbsCap}, ${env.vanCandidateMaxPct}%)`,
    );
  }, 300_000);
  afterAll(async () => {
    // 테스트 DB를 비워 둔다(단말기 5만·결과 행을 남기지 않는다)
    await partners.reset();
    await resetDatabase(t.orm);
    await t.app.close();
  }, 120_000);

  it('A 기본 → B 스캔 도중 변경 → C 다음 실행', async () => {
    await partners.reset();
    await partners.seedVan(van.regs);
    const truthA = await truth();
    const a = await runOnce('A 기본');
    // 참고: 수집 중 HTTP·JSON만(같은 페이지 크기로 목록을 끝까지 받기만 하고 DB에 넣지 않음) — 수집 시간에서 DB 몫을 가늠한다
    const httpStarted = performance.now();
    await vanNow(env.bridgevanPageSize);
    console.log(`[실험 0012] 참고: 목록 ${Math.ceil(N / env.bridgevanPageSize)}페이지 HTTP·JSON만 ${Math.round(performance.now() - httpStarted)}ms(DB 없음)`);

    await partners.reset();
    await partners.configure({ seed: 12, bridgevan: { mutateDuringScan: MUTATE } });
    await partners.seedVan(van.regs);
    const b = await runOnce(`B 변경 ${MUTATE}건/페이지`);
    const truthB = await truth(); // B가 끝난 뒤의 정답(변경을 끈다)

    const c = await runOnce('C 다음 실행(변경 없음)');

    const rows = [a.row, b.row, c.row];
    const cols = Object.keys(rows[0]);
    console.log(`\n[실험 0012] 결과\n| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|`);
    for (const r of rows) console.log(`| ${cols.map((col) => String((r as Record<string, unknown>)[col] ?? '')).join(' | ')} |`);

    // 정답과의 관계(거짓 양성 = 확정했지만 정답에 없음, 놓침 = 정답에 있지만 확정 못 함)
    const diff = (x: Set<string>, y: Set<string>) => [...x].filter((s) => !y.has(s));
    const plantedKeys = new Set([...van.planted].map(serialKey));
    const relation = {
      truthA: truthA.size,
      truthB: truthB.size,
      plantedStillMismatched: [...plantedKeys].filter((s) => truthB.has(s)).length,
      newInPassed: diff(truthB, plantedKeys).length,
      bFalsePositiveBeforeReverify: diff(b.candidateSet, truthB).length,
      bFalsePositiveAfterReverify: diff(b.verifiedSet, truthB).length,
      bMissed: diff(truthB, b.verifiedSet).length,
      cMissed: diff(truthB, c.verifiedSet).length,
      cFalsePositive: diff(c.verifiedSet, truthB).length,
    };
    console.log(`\n[실험 0012] 정답과의 관계 ${JSON.stringify(relation)}`);
    for (const r of [a, b, c]) if (r.error) console.log(`[실험 0012] ${r.row.label} 오류: ${r.error}`);

    expect(rows.every((r) => r.status === VanRunStatus.COMPLETED)).toBe(true);
    // A: 정답 = 심은 어긋남. 후보 = 확정 = 심은 수, 풀림 0, 재검증 조회 = 후보 수
    expect(truthA).toEqual(plantedKeys);
    expect(a.row).toMatchObject({ candidates: van.planted.size, confirmed: van.planted.size, resolved: 0, unverifiable: 0, lookups: van.planted.size });
    expect(a.verifiedSet).toEqual(plantedKeys);
    // B: 지나간 자리만 바뀌므로 스냅샷은 심은 그대로 → 후보 = 심은 수. 재검증 뒤 확정 = 심은 것 중 아직 어긋난 것, 풀림 = 나머지
    expect(b.candidateSet).toEqual(plantedKeys);
    expect(b.row.candidates).toBe(b.row.confirmed + b.row.resolved + b.row.unverifiable);
    expect(b.row.confirmed).toBe(relation.plantedStillMismatched);
    expect(relation.bFalsePositiveAfterReverify).toBe(0);
    expect(relation.bMissed).toBe(relation.newInPassed); // 놓친 것 = 지나간 자리에서 새로 생긴 어긋남뿐
    // C: 변경이 없으니 정답을 그대로 찾는다(B가 놓친 것 포함), 풀림 0
    expect(c.row).toMatchObject({ resolved: 0, confirmed: truthB.size, candidates: truthB.size });
    expect(relation.cMissed + relation.cFalsePositive).toBe(0);
  }, 900_000);
});
