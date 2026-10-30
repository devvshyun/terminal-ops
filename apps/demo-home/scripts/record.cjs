// 시연 홈 녹화기(보강 11, decisions/0093·0094). 시연 묶음(docker-compose.demo.yml)을 깨끗하게 띄운 뒤, 시연 홈 7막을 실제로 진행하며
// 시연 홈이 받은 /api 응답과 실행 시각, 다른 화면 사진을 남긴다. 결과는 GitHub Pages 녹화 재생본의 원본이다.
//
// 사용(저장소 루트, 시연 묶음이 떠 있고 demo-seed가 Exited (0)인 상태):
//   node apps/demo-home/scripts/record.cjs
//   → apps/demo-home/public-replay/recording.json, apps/demo-home/public-replay/shots/*.jpg
// Playwright는 이 컨테이너에 미리 깔린 것을 쓴다(require('playwright')). 10~15분 걸린다(배송 완료·오프라인 판정을 실제로 기다린다).
//
// 비밀 값: 로그인 비밀번호는 apps/api/src/db/seed-accounts.ts에서 읽어 입력 칸에만 넣는다(출력하지 않는다).
// 남기는 것은 시연 홈의 응답 본문뿐이다 — 요청 본문·쿠키·헤더는 남기지 않고, /api/auth/login·logout 응답도 뺀다.
// 다 쓴 뒤 녹화본에 시연 비밀번호가 들어 있지 않은지 직접 확인하고, 있으면 파일을 지우고 멈춘다.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const OUT_JSON = path.join(ROOT, 'apps/demo-home/public-replay/recording.json');
const SHOT_DIR = path.join(ROOT, 'apps/demo-home/public-replay/shots');
const HOST = (app) => `http://${app}.localhost:8080`;
const DEMO = HOST('demo');

const accounts = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/seed-accounts.ts'), 'utf8');
const pw = (id) => accounts.match(new RegExp(`loginId: '${id}'[^}]*password: '([^']+)'`))[1];
const SECRETS = [...accounts.matchAll(/password: '([^']+)'/g)].map((m) => m[1]);

/** 실행 단추 글자 → 단계 key(lib/acts.ts). 제목은 겹친다("되돌리기: 0%"가 5막·6막에) — 글자로 찾고, 없으면 제목으로 */
const LABEL_KEY = {
  '번개택배 429 확률 0%': '5-off',
  '펌웨어 실패율 0%': '6-fail-off',
};
/** 단계 제목 → 단계 key */
const STEP_KEY = {
  '공장 납품 명세': '2-note',
  '입고 대조와 마감': '2-close',
  '배정하고 출고': '3-ship',
  '원격 점검 → 교체 출고': '4-replace',
  '장애 켜기: 429 50%': '5-on',
  '출고 하나 → 반응': '5-ship',
  '정상 배포': '6-ok',
  '장애 켜기: 실패율 60%': '6-fail-on',
  '다시 배포 → 자동 중단': '6-abort',
  '단말기 끄기': '7-off',
  '되돌리기: 켜기': '7-on',
};

const rec = { version: 1, recordedAt: new Date().toISOString(), commit: execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(), durationMs: 0, runs: [], responses: [], shots: [] };
const log = [];
let t0 = 0;
const now = () => Date.now() - t0;
const say = (m) => {
  const line = `[${String(Math.round(now() / 1000)).padStart(4)}s] ${m}`;
  log.push(line);
  console.log(line);
};

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  for (const f of fs.readdirSync(SHOT_DIR)) fs.unlinkSync(path.join(SHOT_DIR, f));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());

  // 1) 시연 홈 로그인(녹화 전)
  await p.goto(DEMO + '/act/1');
  await p.getByLabel('비밀번호').fill(pw('operator'));
  await p.getByRole('button', { name: '로그인' }).click();
  await p.getByText('운영자(시연)').first().waitFor();

  // 2) 녹화 시작 — 시연 홈 출처의 /api 응답만, 같은 GET 경로는 본문이 바뀔 때만
  t0 = Date.now();
  const lastBody = new Map();
  const pending = [];
  p.on('response', (res) => {
    const u = new URL(res.url());
    if (u.origin !== DEMO || !u.pathname.startsWith('/api/')) return;
    if (u.pathname.startsWith('/api/auth/login') || u.pathname.startsWith('/api/auth/logout')) return;
    const t = now();
    const method = res.request().method();
    const url = u.pathname + u.search;
    pending.push(
      res.text().then(
        (text) => {
          let body = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = { message: text.slice(0, 200) };
          }
          if (method === 'GET') {
            const key = JSON.stringify([res.status(), body]);
            if (lastBody.get(url) === key) return;
            lastBody.set(url, key);
          }
          rec.responses.push({ t, method, url, status: res.status(), body });
        },
        () => {},
      ),
    );
  });

  const step = (title) => p.getByRole('region', { name: title });
  const act = async (name) => {
    await p.getByRole('navigation', { name: '막' }).getByRole('link', { name }).click();
    await p.waitForTimeout(1500);
    say(`막 이동: ${name}`);
  };
  /** 실행 단추를 누르고, 끝난 뒤 결과 패널이 다시 읽을 때까지 기다려 end를 적는다 */
  const run = async (title, label) => {
    const btn = step(title).getByRole('button', { name: `실행: ${label}` });
    const t = now();
    await btn.click();
    await step(title).getByRole('button', { name: '실행 중…' }).waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
    await p.waitForTimeout(1500);
    const key = LABEL_KEY[label] ?? STEP_KEY[title];
    if (!key) throw new Error(`단계 key를 모름: ${title} / ${label}`);
    rec.runs.push({ step: key, label, t, end: now() });
    const text = await step(title).innerText();
    say(`실행 ${key} "${label}" → ${text.split('\n').filter((l) => /DM-|운송장|배포 시작|확률|실패율|마감|오류|ERROR|없/.test(l)).slice(0, 2).join(' / ')}`);
  };
  const waitText = async (title, re, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const text = await step(title).innerText();
      if (re.test(text)) return text;
      await p.waitForTimeout(2000);
    }
    throw new Error(`기다림 시간 초과: ${title} ${re}`);
  };
  /** 다른 앱 화면 사진(그 앱에 로그인한 탭) */
  const tabs = {};
  const appTab = async (app, loginId, viewport) => {
    if (tabs[app]) return tabs[app];
    const tab = await ctx.newPage();
    tab.on('dialog', (d) => d.accept());
    if (viewport) await tab.setViewportSize(viewport);
    if (loginId) {
      await tab.goto(HOST(app) + '/login');
      await tab.getByLabel('아이디').fill(loginId);
      await tab.getByLabel('비밀번호').fill(pw(loginId));
      await tab.getByRole('button', { name: '로그인' }).click();
      await tab.waitForURL((u) => !u.pathname.startsWith('/login'));
    }
    tabs[app] = tab;
    return tab;
  };
  const shot = async (app, appPath, title, loginId, viewport) => {
    const tab = await appTab(app, loginId, viewport);
    if (appPath !== null) await tab.goto(HOST(app) + appPath);
    await tab.waitForTimeout(1800);
    const file = `${String(rec.shots.length + 1).padStart(2, '0')}-${app}.jpg`;
    await tab.screenshot({ path: path.join(SHOT_DIR, file), type: 'jpeg', quality: 72, fullPage: true });
    rec.shots.push({ key: `${app}:${appPath ?? tab.url().replace(HOST(app), '')}`, file, title, t: now() });
    say(`사진 ${file}: ${title}`);
    return tab;
  };

  // 다른 화면(왼쪽 아래) — 처음 상태
  await shot('console', '/', '운영 관제', 'monitor');
  await shot('developers', '/', '개발자센터', 'admin');
  await shot('sandbox', '/partners', '시연 도구 — 가상 업체', null);

  // 1막
  await act(/한눈에/);
  await shot('admin', '/', '어드민 처음 화면', 'operator');
  await shot('admin', '/reports/anomalies', '어드민 이상 단말기', 'operator');

  // 2막
  await act(/공장에서 창고로/);
  await run('공장 납품 명세', '납품 명세 불러오기');
  const serials = (await step('공장 납품 명세').getByRole('textbox', { name: '납품 시리얼' }).inputValue()).split('\n');
  const poNo = (await step('공장 납품 명세').innerText()).match(/SE\d+/)[0];
  const f = await appTab('field', 'field', { width: 390, height: 844 });
  await f.goto(HOST('field') + '/scan');
  await f.waitForTimeout(800);
  await f.getByRole('button', { name: '발주분 입고' }).click();
  const v = await f.locator('select option').evaluateAll((os, po) => os.find((o) => o.textContent.includes(po))?.value, poNo);
  await f.locator('select').selectOption(v);
  const input = f.getByLabel(/시리얼/);
  for (const s of serials) {
    await input.fill(s);
    await input.press('Enter');
  }
  await shot('field', null, `현장 박스 스캔 — ${serials.length}대 읽음`, 'field');
  rec.shots[rec.shots.length - 1].key = 'field:/scan';
  await f.getByRole('button', { name: '보내기' }).click();
  say(`현장 스캔 보냄: ${poNo} ${serials.length}대`);
  await waitText('현장 박스 스캔', new RegExp(`입고 ${serials.length} / 명세 ${serials.length}`), 20000);
  await run('입고 대조와 마감', '발주 마감');

  // 3막
  await act(/가맹점까지/);
  await run('배정하고 출고', '재고 한 대를 강남김밥으로 출고');
  const s3 = now();
  await waitText('배송 완료 기다리기', /배송 완료\(DELIVERED\)/, 240000);
  say(`배송 완료까지 ${Math.round((now() - s3) / 1000)}초`);
  await shot('admin', '/batch-runs', '어드민 배치 실행 이력', 'operator');
  await shot('merchant', '/', '매장 화면(강남김밥)', 'merchant-gangnam');

  // 4막: 점주 고장 접수(매장 화면) → 원격 점검·교체 출고(시연 홈) → 배송 → 점주 설치 확인
  await act(/고장과 교체/);
  const m = tabs.merchant;
  await m.goto(HOST('merchant') + '/service-tickets/new?serialNo=DM-0004');
  await m.waitForTimeout(1200);
  await m.getByLabel('단말기').selectOption('DM-0004');
  await m.locator('input[name="symptom"]').first().check();
  await m.getByRole('button', { name: '접수하기' }).click();
  await m.waitForURL(/\/service-tickets\/\d+$/);
  const ticketId = Number(m.url().match(/(\d+)$/)[1]);
  say(`점주 고장 접수: A/S #${ticketId} DM-0004`);
  await shot('merchant', null, `매장 화면 — A/S #${ticketId} 접수`, 'merchant-gangnam');
  rec.shots[rec.shots.length - 1].key = 'merchant:/';
  await waitText('원격 점검 → 교체 출고', new RegExp(`A/S #${ticketId} 원격 점검`), 20000);
  await run('원격 점검 → 교체 출고', `A/S #${ticketId} 원격 점검 → 교체 출고`);
  const s4 = now();
  await m.goto(HOST('merchant') + `/service-tickets/${ticketId}`);
  for (let i = 0; i < 120; i++) {
    if (await m.getByRole('button', { name: '설치 확인' }).count()) break;
    await m.waitForTimeout(3000);
    await m.reload();
  }
  say(`교체품 배송 완료까지 ${Math.round((now() - s4) / 1000)}초`);
  await m.getByRole('button', { name: '설치 확인' }).click();
  await m.waitForTimeout(1500);
  say('점주 설치 확인');
  await shot('merchant', null, `매장 화면 — A/S #${ticketId} 설치 확인 뒤`, 'merchant-gangnam');
  rec.shots[rec.shots.length - 1].key = 'merchant:/';
  await waitText('점주가 설치 확인', /완료|RESOLVED/, 20000).catch(() => say('4-3 결과 글이 바뀌지 않음(계속)'));

  // 5막
  await act(/429/);
  await p.waitForTimeout(4000);
  await run('장애 켜기: 429 50%', '번개택배 429 확률 50%');
  await run('출고 하나 → 반응', '재고 한 대를 번개택배로 출고');
  const s5 = now();
  await waitText('출고 하나 → 반응', /ERROR · 1번째/, 240000).catch(() => say('ERROR · 1번째가 보이지 않음(429가 안 걸렸을 수 있음)'));
  await waitText('출고 하나 → 반응', /(OK|DELIVERED) · [2-9]번째/, 240000).catch(() => say('재시도 성공이 보이지 않음'));
  say(`429 반응까지 ${Math.round((now() - s5) / 1000)}초`);
  await shot('admin', '/batch-runs', '어드민 배치 실행 이력 — 429 재시도', 'operator');
  await run('되돌리기: 0%', '번개택배 429 확률 0%');

  // 6막
  await act(/펌웨어 배포/);
  await run('정상 배포', 'SN-100 새 버전 배포');
  const s6 = now();
  await waitText('정상 배포', /· 완료/, 240000);
  say(`정상 배포 완료까지 ${Math.round((now() - s6) / 1000)}초`);
  await run('장애 켜기: 실패율 60%', '펌웨어 실패율 60%');
  await run('다시 배포 → 자동 중단', 'SN-100 새 버전 배포');
  const s6b = now();
  await waitText('다시 배포 → 자동 중단', /· 중단/, 240000);
  say(`자동 중단까지 ${Math.round((now() - s6b) / 1000)}초: ${(await step('다시 배포 → 자동 중단').innerText()).match(/자동 중단[^\n]*/)?.[0]}`);
  await shot('admin', '/firmware-rollouts', '어드민 펌웨어 배포', 'operator');
  await run('되돌리기: 0%', '펌웨어 실패율 0%');

  // 7막
  await act(/끊긴다/);
  await run('단말기 끄기', 'DM-0005 끄기');
  const s7 = now();
  await waitText('오프라인 판정과 알림', /DM-0005: 오프라인/, 300000);
  say(`오프라인 판정·알림까지 ${Math.round((now() - s7) / 1000)}초`);
  await shot('admin', '/terminals/DM-0005', '어드민 단말기 상세 DM-0005', 'operator');
  await run('되돌리기: 켜기', 'DM-0005 켜기');
  await p.waitForTimeout(6000);

  // 끝 — 다른 화면 한 번 더(시연 뒤)
  await shot('console', '/', '운영 관제 — 시연 뒤', 'monitor');
  rec.durationMs = now();
  await Promise.all(pending);
  rec.responses.sort((a, b) => a.t - b.t);
  await browser.close();

  const json = JSON.stringify(rec);
  const leaked = SECRETS.filter((s) => json.includes(s)).length;
  if (leaked) {
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    throw new Error(`녹화본에 시연 비밀번호가 ${leaked}개 들어 있어 쓰지 않았습니다.`);
  }
  fs.writeFileSync(OUT_JSON, JSON.stringify(rec, null, 1) + '\n');
  say(`끝: 응답 ${rec.responses.length}개(GET이 아닌 것 ${rec.responses.filter((r) => r.method !== 'GET').length}), 실행 ${rec.runs.length}개, 사진 ${rec.shots.length}장, ${Math.round(rec.durationMs / 1000)}초, pageerror ${errors.length}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
