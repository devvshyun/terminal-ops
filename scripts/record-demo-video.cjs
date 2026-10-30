// 시연 영상 녹화기(보강 11, decisions/0097). 시연 묶음(docker-compose.demo.yml)을 깨끗하게 띄운 뒤, docs/demo.md 순서대로
// 실제 앱(어드민·현장·매장·시연 도구·운영 관제·개발자센터)에 그 역할로 로그인해 조작하는 모습을 한 영상으로 남긴다.
// 화면 아래 자막(누가 · 무엇을), 누르는 곳 테두리, 기다리는 구간은 빨리 감기(ffmpeg).
//
// 사용(저장소 루트, 시연 묶음이 떠 있고 demo-seed가 Exited (0)인 직후):
//   node scripts/record-demo-video.cjs
//   → apps/landing/public/media/demo-scenario.mp4 · demo-scenario-poster.jpg (ffmpeg 필요). 녹화 약 10분, 영상 약 5분
// 비밀 값: 로그인 비밀번호는 apps/api/src/db/seed-accounts.ts에서 읽어 비밀번호 칸(가려짐)에만 넣는다. 외부 업체 키 발급은 찍지 않는다(원문이 화면에 나온다).
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'apps/landing/public/media');
const SIZE = { width: 1280, height: 800 };
const FAST = 8; // 기다리는 구간 배속
const H = (app) => (app ? `http://${app}.localhost:8080` : 'http://localhost:8080');
const accounts = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/seed-accounts.ts'), 'utf8');
const pw = (id) => accounts.match(new RegExp(`loginId: '${id}'[^}]*password: '([^']+)'`))[1];

const log = [];
let t0 = 0;
const now = () => Date.now() - t0;
const say = (m) => {
  const line = `[${String(Math.round(now() / 1000)).padStart(4)}s] ${m}`;
  log.push(line);
  console.log(line);
};
/** 빨리 감을 구간(영상 시각 ms) */
const fast = [];

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-scenario-'));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir: tmp, size: SIZE }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const p = await ctx.newPage();
  t0 = Date.now();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => setTimeout(() => d.accept().catch(() => {}), 900)); // 확인창도 잠깐 보인다

  // ── 화면 위에 그리는 것: 자막과 누르는 곳 테두리 ──
  let current = { who: '', text: '', badge: '' };
  const paint = async () => {
    await p
      .evaluate(({ who, text, badge }) => {
        let el = document.getElementById('demo-caption');
        if (!el) {
          el = document.createElement('div');
          el.id = 'demo-caption';
          el.style.cssText =
            'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:2147483647;max-width:1100px;width:calc(100% - 80px);padding:14px 22px;border-radius:14px;background:rgba(10,18,32,.92);color:#fff;font:600 19px/1.5 "IBM Plex Sans KR","Malgun Gothic",sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35);pointer-events:none';
          document.body.appendChild(el);
        }
        el.innerHTML = `${who ? `<span style="display:inline-block;margin-right:10px;padding:2px 10px;border-radius:999px;background:#2f6bff;font-size:14px;vertical-align:2px">${who}</span>` : ''}${text}${badge ? `<span style="display:block;margin-top:4px;color:#ffd38a;font-size:15px">${badge}</span>` : ''}`;
      }, current)
      .catch(() => {});
  };
  const caption = async (who, text, badge = '') => {
    current = { who, text, badge };
    await paint();
    say(`자막 [${who}] ${text}${badge ? ` (${badge})` : ''}`);
  };
  const go = async (url, ms = 1800) => {
    await p.goto(url);
    await p.waitForLoadState('networkidle').catch(() => {});
    await paint();
    await p.waitForTimeout(ms);
  };
  const show = async (locator, ms = 700) => {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.evaluate((el) => {
      el.dataset.demoOutline = el.style.outline;
      el.style.outline = '4px solid #ff9f1a';
      el.style.outlineOffset = '3px';
    });
    await p.waitForTimeout(ms);
  };
  const click = async (locator, ms = 700) => {
    await show(locator, ms);
    await locator.evaluate((el) => (el.style.outline = el.dataset.demoOutline || '')).catch(() => {});
    await locator.click();
    await paint();
  };
  const hold = (ms) => p.waitForTimeout(ms);
  /** 조건이 맞을 때까지 기다린다 — 그 구간을 빨리 감기로 표시한다(reload: 새로 고치며 본다) */
  const waitFor = async (label, check, { ms = 240000, reload = false, every = 3000, badge } = {}) => {
    const from = now();
    const keep = current;
    if (badge) await caption(keep.who, keep.text, badge);
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await check().catch(() => false)) {
        const took = now() - from;
        if (took > 6000) fast.push([from + 1500, now() - 800]);
        say(`기다림 끝: ${label} ${Math.round(took / 1000)}초`);
        if (badge) await caption(keep.who, keep.text);
        return took;
      }
      await hold(every);
      if (reload) {
        await p.reload();
        await p.waitForLoadState('networkidle').catch(() => {});
        await paint();
      }
    }
    throw new Error(`기다림 시간 초과: ${label}`);
  };
  const loggedIn = new Set();
  const login = async (app, id, who) => {
    if (loggedIn.has(`${app}:${id}`)) return;
    await go(H(app) + '/login', 600);
    // 같은 앱에 다른 사람이 로그인해 있으면(호스트마다 쿠키 하나) 로그인 화면 대신 그 사람 화면이 열린다 — 로그아웃부터
    if (!new URL(p.url()).pathname.startsWith('/login')) {
      await caption(who, '앞사람이 로그아웃합니다.');
      await click(p.getByRole('button', { name: '로그아웃' }), 400);
      await p.waitForURL((u) => u.pathname.startsWith('/login'));
      for (const k of [...loggedIn]) if (k.startsWith(`${app}:`)) loggedIn.delete(k);
    }
    await caption(who, `${id}로 로그인합니다.`);
    await p.getByLabel('아이디').fill('');
    await p.getByLabel('아이디').type(id, { delay: 40 });
    await p.getByLabel('비밀번호').fill(pw(id));
    await click(p.getByRole('button', { name: '로그인' }), 400);
    await p.waitForURL((u) => !u.pathname.startsWith('/login'));
    await p.waitForLoadState('networkidle').catch(() => {});
    await paint();
    loggedIn.add(`${app}:${id}`);
  };
  const text = (loc) => loc.innerText().catch(() => '');

  // ── 0. 소개 ──
  await go(H(null), 600);
  await caption('', '단말온 — 가상의 결제단말기 운영사 사내 시스템. 실제로 띄운 서버(api · MySQL · Redis · 워커)에서, 역할마다 다른 화면으로 시나리오를 진행합니다.');
  await hold(5000);

  // ── 1. 운영자 · 어드민 처음 화면 ──
  await login('admin', 'operator', '운영자 · 어드민');
  await caption('운영자 · 어드민', '처음 화면 "지금 볼 것" — 장기 오프라인 1, 배송 완료 후 미설치 1, VAN 어긋남 4. 밤마다 도는 작업이 미리 찾아 둔 것입니다.');
  await hold(5500);
  await click(p.getByRole('link', { name: '이상 단말기', exact: true }).first());
  await paint();
  await caption('운영자 · 어드민', '이상 단말기: DM-0021은 4일째 하트비트가 없고, DM-0022는 배송 완료 8일 뒤에도 설치되지 않았습니다.');
  await hold(5000);

  // ── 2. 운영자 · 배송 중인 단말기 ──
  await go(H('admin') + '/terminals/DM-0019');
  await caption('운영자 · 어드민', '배송 중인 단말기 DM-0019 — 운송장과 택배 이력. 워커가 택배사(가상 번개택배) API를 주기적으로 조회해 상태를 바꿉니다.');
  await hold(5000);

  // ── 3. 가맹점주 · 매장 ──
  await login('merchant', 'merchant-yeoksam', '가맹점주 · 매장 화면');
  await caption('가맹점주 · 매장 화면', '역삼카페 점주의 휴대폰 화면 — 오고 있는 교체 단말기와 A/S 진행 단계가 보입니다. 같은 데이터, 다른 역할, 다른 화면.');
  await hold(5500);

  // ── 4. 공장 납품 → 현장 박스 스캔 ──
  await go(H('admin') + '/reports/purchase-orders');
  const poNo = (await text(p.locator('main'))).match(/SE\d+/)[0];
  await caption('운영자 · 어드민', `발주 ${poNo} — 공장(가상 세움전자)에 SN-100 10대를 주문했습니다.`);
  await hold(3500);
  await go(H('sandbox') + '/partners', 800);
  await caption('시연자 · 시연 도구', '공장이 보낸 납품 명세를 엽니다. 10대를 주문했는데 명세에는 8대뿐입니다.');
  const note = p.getByRole('region', { name: '세움전자 납품 명세' });
  await note.scrollIntoViewIfNeeded();
  await note.getByLabel('발주번호').type(poNo, { delay: 25 });
  await click(note.getByRole('button', { name: '보기' }));
  const serials = (await note.getByRole('textbox', { name: '납품 시리얼' }).inputValue()).split('\n').filter(Boolean);
  await show(note.getByRole('textbox', { name: '납품 시리얼' }), 3500);
  await login('field', 'field', '현장 작업자 · 현장 화면');
  await go(H('field') + '/scan', 800);
  await caption('현장 작업자 · 현장 화면', `창고에 도착한 상자를 PDA로 스캔합니다 — 발주분 입고, 발주 ${poNo}.`);
  await click(p.getByRole('button', { name: '발주분 입고' }));
  const opt = await p.locator('select option').evaluateAll((os, po) => os.find((o) => o.textContent.includes(po))?.value, poNo);
  await p.locator('select').selectOption(opt);
  const input = p.getByLabel(/시리얼/);
  for (const s of serials) {
    await input.type(s, { delay: 8 });
    await input.press('Enter');
    await hold(250);
  }
  await caption('현장 작업자 · 현장 화면', `${serials.length}대를 찍고 보냅니다. 같은 상자를 두 번 보내도 한 번만 처리됩니다(멱등 키).`);
  await hold(1500);
  await click(p.getByRole('button', { name: '보내기' }));
  await hold(4000);

  // ── 5. 운영자 · 발주 입고 대조와 마감 ──
  await go(H('admin') + '/reports/purchase-orders', 800);
  await click(p.getByRole('button', { name: poNo }));
  await caption('운영자 · 어드민', '발주 10 · 명세 8 · 입고 8 — 공장이 2대를 덜 보낸 것을 대조로 잡아냅니다. 마감합니다.');
  await hold(4000);
  await click(p.getByRole('button', { name: '마감' }));
  await hold(3500);

  // ── 6·7. 택배사 429 → 출고 → 재시도 ──
  await go(H('sandbox') + '/partners', 800);
  await caption('시연자 · 시연 도구', '장애를 켭니다: 택배사(가상 번개택배) API가 조회의 50%를 "429 너무 많은 요청"으로 거절하게 합니다.');
  const bungae = p.getByRole('region', { name: '번개택배' });
  await bungae.scrollIntoViewIfNeeded();
  await bungae.getByLabel('429 확률(%)').fill('');
  await bungae.getByLabel('429 확률(%)').type('50', { delay: 80 });
  await click(bungae.getByRole('button', { name: '적용' }));
  await hold(2000);
  await go(H('admin') + '/terminals/DM-0014', 800);
  await caption('운영자 · 어드민', '재고 단말기 DM-0014를 가맹점 역삼카페에 배정하고, 번개택배로 출고합니다.');
  await p.getByLabel('배정 가맹점').selectOption('YEOKSAM-CAFE');
  await click(p.getByRole('button', { name: '가맹점 배정' }));
  await hold(2500);
  await p.getByLabel('택배사').selectOption('BUNGAE');
  await click(p.getByRole('button', { name: '출고(운송장 발급)' }));
  await hold(3000);
  await caption('운영자 · 어드민', '운송장이 발급됐습니다. 이제 워커가 15초마다 택배사에 배송 상태를 묻는데, 429가 섞여 옵니다.');
  await hold(3000);
  await go(H('admin') + '/batch-runs', 800);
  await caption('시스템 · 어드민 배치 실행 이력', '택배 수집 작업: 429를 받으면 ERROR로 남기고, 택배사가 알려 준 시간(Retry-After)만큼 기다렸다 다시 시도해 받아 옵니다.');
  // 429로 실패한 줄(ERROR, 내용에 429) — 목록 위쪽에 없을 수 있어 그 줄을 찾아 화면에 보인다
  const row429 = p.getByRole('row').filter({ hasText: 'ERROR' }).filter({ hasText: '429' }).first();
  await waitFor('429 ERROR 줄', async () => (await row429.count()) > 0, { reload: true, every: 4000, badge: `⏩ 기다리는 동안 ${FAST}배 빨리 감기` });
  await show(row429, 5500);
  await login('console', 'monitor', '관제 · 운영 관제');
  await go(H('console') + '/errors', 800);
  await caption('관제 · 운영 관제', '운영 관제 "최근 오류"에도 같은 429가 보입니다 — 관제 담당은 서버 로그를 열지 않고 여기서 봅니다.');
  await hold(5000);
  await go(H('sandbox') + '/partners', 800);
  await caption('시연자 · 시연 도구', '장애를 끕니다(429 확률 0%).');
  await p.getByRole('region', { name: '번개택배' }).getByLabel('429 확률(%)').fill('0');
  await click(p.getByRole('region', { name: '번개택배' }).getByRole('button', { name: '적용' }));
  await hold(2000);

  // ── 8. 가맹점주 · 고장 접수 ──
  await login('merchant', 'merchant-gangnam', '가맹점주 · 매장 화면');
  await go(H('merchant') + '/service-tickets/new?serialNo=DM-0004', 800);
  await caption('가맹점주 · 매장 화면', '강남김밥 점주가 단말기 DM-0004의 고장을 접수합니다.');
  await p.getByLabel('단말기').selectOption('DM-0004');
  await click(p.locator('input[name="symptom"]').first());
  await p.getByLabel('메모').type('어제부터 카드를 읽지 못합니다', { delay: 30 });
  await click(p.getByRole('button', { name: '접수하기' }));
  await p.waitForURL(/\/service-tickets\/\d+$/);
  await paint();
  await hold(3500);
  await go(H('admin') + '/service-tickets', 800);
  await caption('운영자 · 어드민', '운영자의 A/S 목록에 방금 접수가 들어왔습니다. 원격 점검 → 안 되면 교체품 출고로 이어집니다.');
  await hold(5000);

  // ── 9. 펌웨어 단계 배포 ──
  await go(H('admin') + '/firmware-rollouts', 800);
  await caption('운영자 · 어드민', '새 펌웨어 SN-100 1.1.0을 10% → 50% → 100%로 나눠 배포합니다.');
  await click(p.getByRole('button', { name: '새 배포 만들기' }));
  const form = p.getByRole('form', { name: '배포 만들기' });
  await form.getByLabel('배포 모델').selectOption('SN-100');
  await hold(800);
  await form.getByLabel('배포 버전').selectOption('1.1.0');
  await click(form.getByRole('button', { name: '배포 시작' }));
  await hold(2500);
  await caption('단말기 · 시스템', '단말기들이 하트비트 응답으로 지시를 받아 업데이트하고 결과를 보고합니다. 단계마다 실패율을 보고 다음 단계로 넘어갑니다.');
  await waitFor('1.1.0 완료', async () => /SN-100 1\.1\.0\s*완료/.test(await text(p.locator('main'))), { reload: true, every: 3000, badge: `⏩ ${FAST}배 빨리 감기` });
  await hold(4500);

  // ── 10. 실패율 60% → 자동 중단 ──
  await go(H('sandbox') + '/devices', 800);
  await caption('시연자 · 시연 도구', '장애를 켭니다: 시뮬레이터 단말기가 펌웨어 업데이트를 60% 확률로 실패하게 합니다.');
  await p.getByLabel('펌웨어 실패율(%)').fill('');
  await p.getByLabel('펌웨어 실패율(%)').type('60', { delay: 80 });
  await click(p.getByRole('button', { name: '설정 적용' }));
  await hold(2500);
  await go(H('admin') + '/firmware-rollouts', 800);
  await caption('운영자 · 어드민', '1.2.0을 등록하고 다시 배포합니다.');
  await click(p.getByRole('button', { name: '펌웨어 등록' }));
  const reg = p.getByRole('form', { name: '펌웨어 등록' });
  await reg.getByLabel('펌웨어 모델').selectOption('SN-100');
  await reg.getByLabel('버전').type('1.2.0', { delay: 60 });
  await click(reg.getByRole('button', { name: '등록' }));
  await hold(1500);
  await click(p.getByRole('button', { name: '새 배포 만들기' }));
  const form2 = p.getByRole('form', { name: '배포 만들기' });
  await form2.getByLabel('배포 모델').selectOption('SN-100');
  await hold(800);
  await form2.getByLabel('배포 버전').selectOption('1.2.0');
  await click(form2.getByRole('button', { name: '배포 시작' }));
  await hold(2000);
  await caption('시스템', '실패가 기준(20%)을 넘으면 그 단계에서 스스로 멈춥니다 — 나머지 단말기로 번지지 않습니다.');
  // "자동 중단: N단계 …"(끝난 이유) — 배포 만들기 폼의 안내 글에도 "자동 중단"이 있어 그 말만으로는 0초에 맞았다(첫 녹화)
  await waitFor('자동 중단', async () => /자동 중단: \d단계/.test(await text(p.locator('main'))), { reload: true, every: 3000, badge: `⏩ ${FAST}배 빨리 감기` });
  await show(p.getByText(/자동 중단: \d단계/).first(), 5500);
  await go(H('sandbox') + '/devices', 800);
  await caption('시연자 · 시연 도구', '장애를 끕니다(실패율 0%).');
  await p.getByLabel('펌웨어 실패율(%)').fill('0');
  await click(p.getByRole('button', { name: '설정 적용' }));
  await hold(2000);

  // ── 11. 단말기 끊김 → 오프라인 판정·알림 ──
  await caption('시연자 · 시연 도구', '역삼카페 단말기 DM-0005의 전원을 끕니다(시뮬레이터가 하트비트를 멈춤).');
  await click(p.getByRole('row', { name: 'DM-0005' }).getByRole('button', { name: '끄기' }));
  await hold(2000);
  await go(H('admin') + '/terminals/DM-0005', 800);
  await caption('시스템 · 어드민 단말기 상세', '하트비트가 90초 끊기면 오프라인으로 판정합니다.');
  await waitFor('DM-0005 오프라인', async () => /오프라인/.test(await text(p.getByRole('heading', { name: '접속 상태' }).locator('xpath=..'))), {
    reload: true,
    every: 5000,
    ms: 300000,
    badge: `⏩ ${FAST}배 빨리 감기 — 실제로는 90초 남짓`,
  });
  await show(p.getByRole('heading', { name: '접속 상태' }).locator('xpath=..'), 4000);
  await go(H('sandbox') + '/partners', 800);
  await caption('시스템 · 메신저(가상 톡톡)', '오프라인 알림이 메신저로 갔습니다.');
  const tok = p.getByRole('region', { name: '톡톡 메시지' });
  await tok.scrollIntoViewIfNeeded();
  await show(tok, 5000);
  await go(H('sandbox') + '/devices', 600);
  await click(p.getByRole('row', { name: 'DM-0005' }).getByRole('button', { name: '켜기' }));
  await hold(1000);

  // ── 12. 관제 · 운영 관제 대시보드 ──
  await go(H('console') + '/', 800);
  await caption('관제 · 운영 관제', '큐 · 워커 · 처리량 · 알림 발송 상태를 한 화면에서 — 실패한 작업은 여기서 다시 시도합니다.');
  await hold(6000);

  // ── 13. 개발자센터 ──
  await login('developers', 'admin', 'ADMIN · 개발자센터');
  await caption('ADMIN · 개발자센터', '외부 업체(가상 한올POS)가 우리 API를 부르도록 업체별 키와 범위를 관리합니다.');
  await hold(5500);

  // ── 끝 ──
  await go(H(null), 600);
  await caption('', '끝 — 시연하기에서 같은 시나리오를 단계마다 직접 실행해 볼 수 있습니다.');
  await hold(4000);

  const total = now();
  const video = p.video();
  await ctx.close();
  await browser.close();
  const webm = await video.path();

  // ── 편집: 빨리 감기 구간을 FAST배로, 나머지는 그대로 ──
  const parts = [];
  let at = 0;
  for (const [a, b] of fast.sort((x, y) => x[0] - y[0])) {
    if (a > at) parts.push([at, a, 1]);
    parts.push([a, b, FAST]);
    at = b;
  }
  parts.push([at, total, 1]);
  const filters = parts.map(([a, b, k], i) => `[0:v]trim=start=${(a / 1000).toFixed(3)}:end=${(b / 1000).toFixed(3)},setpts=(PTS-STARTPTS)/${k}[v${i}]`);
  const concat = `${parts.map((_, i) => `[v${i}]`).join('')}concat=n=${parts.length}:v=1:a=0[out]`;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const mp4 = path.join(OUT_DIR, 'demo-scenario.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-filter_complex', [...filters, concat].join(';'), '-map', '[out]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '12', '-i', mp4, '-frames:v', '1', '-q:v', '4', path.join(OUT_DIR, 'demo-scenario-poster.jpg')]);
  fs.rmSync(tmp, { recursive: true, force: true });
  const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]).toString().trim();
  say(`끝: 녹화 ${Math.round(total / 1000)}초 → 영상 ${Math.round(Number(dur))}초, 빨리 감기 ${fast.length}구간, ${(fs.statSync(mp4).size / 1024 / 1024).toFixed(1)}MB, pageerror ${errors.length}`);
  fs.writeFileSync(path.join(os.tmpdir(), 'demo-scenario.log'), log.join('\n') + '\n');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
