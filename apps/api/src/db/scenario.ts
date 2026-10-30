import type { Carrier } from '@terminal-ops/contracts';
import { DEMO_ACCOUNTS } from './seed-accounts.js';

/**
 * 시연 데이터(보강 9, decisions/0089). DB에 직접 넣지 않고 **실제 HTTP API**로 만든다 — 로그인·역할 검사·전이 서비스·이력·Outbox를
 * 운영과 같은 길로 지나, 시연 화면에 보이는 이력·알림이 진짜로 쌓인다(CLAUDE.md "상태 변경은 전이 서비스 한 곳으로만").
 * 가상 업체 서버·시뮬레이터는 그 관리 API(`/__admin`)로 설정한다.
 *
 * 다시 돌려도 두 번 넣지 않는다: 마지막에 만드는 외부 업체(`HANOL-POS`)와 그 키가 있으면 건너뛴다.
 * 첫 단말기나 그 업체만 있고 키가 없으면(도중에 멈춘 실행) 멈추고 볼륨을 지우라고 알린다 — 반쯤 들어간 데이터에 덧붙이지 않는다.
 * 건너뛸 때도 메모리에만 있는 상태(브릿지VAN 등록, 시뮬레이터 설정·시작)는 다시 맞춘다 — 묶음을 down/up하면 두 서버가 비어 있다(최종 검토).
 * 세움전자 발주(납품 명세)는 다시 만들 수 없다(발주번호가 업체 서버 메모리에만 있다) — 시나리오 문서가 "새 발주"를 안내한다.
 */
export interface ScenarioOptions {
  /** api 주소(예 http://api:3000) */
  apiUrl: string;
  /** 가상 업체 서버 주소(예 http://partners:4010) */
  partnersUrl: string;
  /** 시뮬레이터 관리 API 주소. 없으면 시뮬레이터 설정을 건너뛴다(테스트) */
  simUrl?: string;
  /** 시뮬레이터가 하트비트를 보낼 api 주소(시뮬레이터 컨테이너에서 본 주소) */
  simTargetUrl?: string;
  /** 시연 계정 대신 쓸 로그인(테스트가 자기 계정으로) — 역할별 아이디·비밀번호 */
  logins?: Partial<Record<'admin' | 'operator', { loginId: string; password: string }>>;
  log?: (line: string) => void;
}

export type ScenarioResult = { skipped: true } | { skipped: false; inService: string[]; summary: Record<string, number | string> };

/** 시연 단말기 시리얼: DM-0001 … */
export const demoSerial = (n: number) => `DM-${String(n).padStart(4, '0')}`;
/** 운영 중 단말기 — 가맹점 셋에 4대씩 */
export const IN_SERVICE_COUNT = 12;
const MERCHANTS = ['GANGNAM-KIMBAP', 'YEOKSAM-CAFE', 'PANGYO-BUNSIK'];
const SN100_PASS = ['POWER', 'NETWORK', 'CARD_READER', 'PRINTER'].map((itemCode) => ({ itemCode, passed: true }));
/** 다 끝났다는 표시(마지막에 만든다) */
export const SCENARIO_DONE_PARTNER = 'HANOL-POS';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 쿠키 하나를 들고 다니는 아주 작은 HTTP 손님 */
class Client {
  private cookie = '';
  constructor(private readonly base: string) {}

  async login(loginId: string, password: string): Promise<void> {
    const res = await fetch(`${this.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId, password }) });
    if (!res.ok) throw new HttpError(res.status, `로그인 실패(${loginId}): HTTP ${res.status}`);
    const sid = res.headers.getSetCookie().find((c) => c.startsWith('sid='));
    if (!sid) throw new Error(`로그인 응답에 세션 쿠키가 없습니다(${loginId})`);
    this.cookie = sid.split(';')[0];
  }

  async call<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown, ok: number[] = [200, 201, 202]): Promise<{ status: number; body: T }> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { ...(this.cookie ? { Cookie: this.cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    // 상태를 먼저 본다 — 오류 본문이 JSON이 아니어도(프록시 HTML 등) 어느 요청이 몇으로 실패했는지 남게(최종 검토)
    if (!ok.includes(res.status)) throw new HttpError(res.status, `${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  }
}

const demoLogin = (loginId: string) => {
  const account = DEMO_ACCOUNTS.find((a) => a.loginId === loginId);
  if (!account) throw new Error(`시연 계정 ${loginId}이 없습니다`);
  return { loginId: account.loginId, password: account.password };
};

/** api가 뜰 때까지(GET /health) 기다린다 */
export async function waitForApi(apiUrl: string, timeoutMs = 120_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`${apiUrl}/health`)).ok) return;
    } catch {
      // 아직 안 떴다
    }
    if (Date.now() > until) throw new Error(`api(${apiUrl})가 ${timeoutMs / 1000}초 안에 뜨지 않았습니다`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function runScenario(opts: ScenarioOptions): Promise<ScenarioResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const admin = new Client(opts.apiUrl);
  const op = new Client(opts.apiUrl);
  const a = opts.logins?.admin ?? demoLogin('admin');
  const o = opts.logins?.operator ?? demoLogin('operator');
  await admin.login(a.loginId, a.password);
  await op.login(o.loginId, o.password);

  const partnerAdmin = (path: string, body: unknown) =>
    fetch(`${opts.partnersUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => {
      if (!r.ok) throw new Error(`가상 업체 ${path} → HTTP ${r.status}: ${await r.text()}`);
      return r.json() as Promise<unknown>;
    });

  // 이미 했나 — 마지막 단계(업체 + 키)까지 있어야 "다 했다"
  const done = (await admin.call<{ code: string; totalKeys: number }[]>('GET', '/admin/partners')).body.find((p) => p.code === SCENARIO_DONE_PARTNER);
  if (done && done.totalKeys > 0) {
    await rearm(opts, partnerAdmin, log);
    log('시연 데이터가 이미 있습니다 — 건너뜀(가상 업체·시뮬레이터 상태만 다시 맞춤)');
    return { skipped: true };
  }
  if (done || (await op.call('GET', `/terminals/${demoSerial(1)}`, undefined, [200, 404])).status === 200) {
    throw new Error(`시연 데이터가 도중에 멈춘 채 남아 있습니다(마지막 단계가 없다). docker compose -f docker-compose.demo.yml down -v 로 볼륨을 지우고 다시 띄우세요.`);
  }

  const version = async (serialNo: string) => (await op.call<{ version: number }>('GET', `/terminals/${serialNo}`)).body.version;
  const register = (serialNo: string) => op.call('POST', '/terminals', { serialNo, modelCode: 'SN-100' });
  const inspect = (serialNo: string) => op.call('POST', `/terminals/${serialNo}/inspections`, { results: SN100_PASS });
  const transition = async (serialNo: string, to: string, reason: string) => op.call('POST', `/terminals/${serialNo}/transitions`, { to, reason, expectedVersion: await version(serialNo) });
  const allocate = async (serialNo: string, merchantCode: string) => op.call('POST', `/terminals/${serialNo}/allocations`, { merchantCode, expectedVersion: await version(serialNo) });
  const ship = async (serialNo: string, carrier: Carrier) => op.call('POST', '/shipments', { serialNo, carrier, expectedVersion: await version(serialNo) });
  const stock = async (serialNo: string) => {
    await register(serialNo);
    await inspect(serialNo);
    await transition(serialNo, 'IN_STOCK', '재고 편입(시연 데이터)');
  };

  let n = 0;
  const next = () => demoSerial(++n);

  // 1) 운영 중 12대: 재고 → 배정 → 출고(번개) → 배송 완료 → 설치(운영 중)
  const inService: string[] = [];
  for (let i = 0; i < IN_SERVICE_COUNT; i += 1) {
    const s = next();
    await stock(s);
    await allocate(s, MERCHANTS[i % MERCHANTS.length]);
    await ship(s, 'BUNGAE');
    await transition(s, 'DELIVERED', '배송 완료(시연 데이터)');
    await transition(s, 'IN_SERVICE', '설치 확인(시연 데이터)');
    inService.push(s);
  }
  log(`운영 중 ${inService.length}대`);

  // 2) 재고 3, 입고(검수 전) 2, 배정 1, 배송 중 2(번개·느림보 — 워커의 택배 수집이 시간이 지나며 배송 완료로). 재고 첫 대는 3)에서 A/S 교체품으로 나간다
  const inStock = [next(), next(), next()];
  for (const s of inStock) await stock(s);
  const received = [next(), next()];
  for (const s of received) await register(s);
  const allocated = next();
  await stock(allocated);
  await allocate(allocated, 'PANGYO-BUNSIK');
  const shipping: [string, Carrier][] = [
    [next(), 'BUNGAE'],
    [next(), 'NEURIMBO'],
  ];
  for (const [s, carrier] of shipping) {
    await stock(s);
    await allocate(s, 'YEOKSAM-CAFE');
    await ship(s, carrier);
  }

  // 3) A/S: 강남김밥 접수 1(그대로), 역삼카페 접수 → 원격 점검(해결 안 됨) → 교체 출고(재고 첫 대)
  const gangnam = inService[0];
  const yeoksam = inService[1];
  await op.call('POST', '/service-tickets', { serialNo: gangnam, symptom: '카드 인식이 잘 안 됩니다(마그네틱만 됨)' });
  const ticket = (await op.call<{ id: number }>('POST', '/service-tickets', { serialNo: yeoksam, symptom: '영수증이 출력되지 않습니다' })).body;
  await op.call('POST', `/service-tickets/${ticket.id}/remote-checks`, { resolved: false, note: '원격 점검: 프린터 헤드 응답 없음 — 교체' });
  await op.call('POST', `/service-tickets/${ticket.id}/replacements`, { replacementSerialNo: inStock[0], carrier: 'BUNGAE' });
  log('A/S 접수 1 · 교체 출고 1');
  // 개수는 교체 출고 뒤에 센다 — 교체품은 재고에서 배송 중으로 옮겨 갔다(2026-10-30 리허설: 진행 줄이 출고 전 "재고 3 · 배송 중 2"였다)
  const counts = { inStock: inStock.length - 1, received: received.length, allocated: 1, shipping: shipping.length + 1 };
  log(`재고 ${counts.inStock} · 입고 ${counts.received} · 배정 ${counts.allocated} · 배송 중 ${counts.shipping}(교체품 포함)`);

  // 4) 발주: 세움전자가 2대 덜 보내게 해 두고 10대 → 되돌림(발주가 실패해도 — 다른 시연 단계에 남지 않게)
  await partnerAdmin('/__admin/config', { seum: { shortfall: 2 } });
  let po: { poNo: string };
  try {
    po = (await op.call<{ poNo: string }>('POST', '/purchase-orders', { modelCode: 'SN-100', quantity: 10 })).body;
  } finally {
    await partnerAdmin('/__admin/config', { seum: { shortfall: 0 } });
  }
  log(`발주 ${po.poNo}(10대, 납품 8)`);

  // 5) 펌웨어 SN-100 1.1.0(배포는 시연 중에 만든다)
  await op.call('POST', '/firmware', { modelCode: 'SN-100', version: '1.1.0' });

  // 6) 브릿지VAN 등록(rearm) → VAN 대조 → 어긋남 넷(미등록 2 · 가맹점 다름 1 · 운영 아님 1 — 교체로 회수 요청된 DM-0002)
  //    시뮬레이터도 rearm이 설정·시작한다(운영 중 12대, 10초마다 — 회수 요청된 DM-0002는 꺼 둔다)
  const registrations = await rearm(opts, partnerAdmin, log);
  await op.call('POST', '/van-reconciliations', { acknowledgeDrop: true });
  log('VAN 대조 실행 요청');

  // 7) 지난주 주간 리포트 → 톡톡메신저(첨부)
  await op.call('POST', '/reports/weekly', {});

  // 9) 마지막: 외부 업체와 키 하나(원문은 출력하지 않는다 — 시연 키는 DEMO 업체 아래 시드에 있다). 이 업체가 "다 끝났다" 표시
  const partner = (await admin.call<{ id: number }>('POST', '/admin/partners', { code: SCENARIO_DONE_PARTNER, name: '한올POS(가상)', memo: '가맹점 POS에서 단말기 상태 조회' })).body;
  await admin.call('POST', '/admin/partner-keys', { partnerId: partner.id, name: '운영 서버', scopes: ['terminal-status:read'] });
  log('외부 업체 한올POS(가상)와 키 하나');

  return {
    skipped: false,
    inService,
    summary: { inService: inService.length, ...counts, poNo: po.poNo, vanRegistrations: registrations },
  };
}

/** 회수 요청으로 운영에서 빠진 단말기(역삼카페 첫 대, A/S 교체) — 시뮬레이터에서 꺼 둔다 */
const RETURN_REQUESTED = demoSerial(2);

/**
 * 메모리에만 있는 시연 상태를 맞춘다(처음 실행 · 건너뛸 때 모두). 시연 단말기는 늘 DM-0001~0012라 API를 읽지 않고 정한다.
 * - 브릿지VAN 등록: 앞 10대(셋째는 VAN에 다른 가맹점으로), 마지막 둘은 미등록 — 대조하면 어긋남이 생긴다
 * - 시뮬레이터: 운영 중 12대 하트비트 10초마다, 회수 요청된 한 대는 꺼 둔다. 돌던 중이면 그대로 둔다(설정만 맞춤)
 * @returns 브릿지VAN 등록 수
 */
async function rearm(opts: ScenarioOptions, partnerAdmin: (path: string, body: unknown) => Promise<unknown>, log: (line: string) => void): Promise<number> {
  const serials = Array.from({ length: IN_SERVICE_COUNT }, (_, i) => demoSerial(i + 1));
  const registrations = serials.slice(0, IN_SERVICE_COUNT - 2).map((serialNo, i) => ({
    tid: `TID${String(i + 1).padStart(5, '0')}`,
    serialNo,
    merchantCode: i === 2 ? 'GANGNAM-KIMBAP' : MERCHANTS[i % MERCHANTS.length], // 셋째(판교분식)는 VAN에 강남김밥으로 — 가맹점 다름
    status: 'ACTIVE',
  }));
  await partnerAdmin('/__admin/bridgevan/registrations', { registrations, replace: true });
  if (opts.simUrl) {
    const sim = (path: string, body?: unknown) =>
      fetch(`${opts.simUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => {
        if (!r.ok) throw new Error(`시뮬레이터 ${path} → HTTP ${r.status}: ${await r.text()}`);
      });
    await sim('/__admin/config', { targetUrl: opts.simTargetUrl ?? opts.apiUrl, serials, offlineSerials: [RETURN_REQUESTED], intervalMs: 10_000 });
    await sim('/__admin/start');
    log(`시뮬레이터 시작(${serials.length}대, 10초마다, ${RETURN_REQUESTED} 꺼 둠)`);
  }
  log(`브릿지VAN 등록 ${registrations.length}건`);
  return registrations.length;
}
