/**
 * 소개 페이지 스크립트(decisions/0078). 하는 일은 둘:
 * 1. content.ts의 숫자·기록·생애주기를 화면에 채운다(글은 기록과 같은지 content.test.ts가 본다)
 * 2. 움직임(GSAP ScrollTrigger·SplitText) — 동작 줄이기 설정이면 하나도 하지 않는다. 글은 움직임 없이도 처음부터 다 보인다
 */
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SplitText } from 'gsap/SplitText';
import { blobUrl, LIFECYCLE, RECORD_TITLES, recordCounts, REPO_URL, STATS } from './content';
import './styles.css';

const esc = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fileNo = (path: string) => path.match(/\/(\d{4})-/)?.[1] ?? '';

function fill() {
  document.querySelectorAll<HTMLAnchorElement>('[data-repo]').forEach((a) => (a.href = REPO_URL));
  document.querySelectorAll<HTMLAnchorElement>('[data-repo-path]').forEach((a) => (a.href = blobUrl(a.dataset.repoPath!)));

  const life = document.querySelector('[data-lifecycle]')!;
  life.innerHTML = LIFECYCLE.map(
    (s) => `<li class="stage${s.code === 'IN_SERVICE' ? ' live' : ''}">
      <span class="stage-code">${esc(s.code)}</span>
      <h3 class="stage-name">${esc(s.name)}</h3>
      <p class="stage-how">${esc(s.how)}</p>
      <span class="stage-who">${esc(s.who)}</span>
    </li>`,
  ).join('');

  const stats = document.querySelector('[data-stats]')!;
  stats.innerHTML = STATS.map(
    (s) => `<li class="stat">
      <p class="stat-value"><span data-num="${esc(s.value)}">${esc(s.value)}</span><small>${esc(s.unit)}</small></p>
      <p class="stat-title">${esc(s.title)}</p>
      <p class="stat-body">${esc(s.body)}</p>
      <a class="stat-src" href="${blobUrl(s.source)}" target="_blank" rel="noreferrer">experiments/${fileNo(s.source)} →</a>
    </li>`,
  ).join('');

  const counts = recordCounts();
  document.querySelectorAll<HTMLElement>('[data-count]').forEach((dd) => {
    dd.textContent = String(counts[dd.dataset.count as keyof typeof counts]);
  });

  const records = document.querySelector('[data-records]')!;
  records.innerHTML = RECORD_TITLES.map(
    (r) => `<li><a href="${blobUrl(r.source)}" target="_blank" rel="noreferrer">
      <span class="record-kind">${esc(r.kind)}</span>
      <span class="record-title">${esc(r.title)}</span>
      <span class="record-no">${fileNo(r.source)}</span>
    </a></li>`,
  ).join('');
}

/** 위 띠: 처음 화면을 지나면 바탕을 깐다 */
function bar() {
  const el = document.querySelector('.bar')!;
  const update = () => el.classList.toggle('solid', window.scrollY > 40);
  update();
  window.addEventListener('scroll', update, { passive: true });
}

/** 시리얼 글자판: 숫자 칸이 잠깐 돌다가 왼쪽부터 제자리에 선다(공항 출발 안내판처럼). 글자·하이픈 자리는 그대로 */
function flap(el: HTMLElement) {
  const target = el.textContent ?? '';
  const start = performance.now();
  const settleEach = 55; // ms — 칸 하나가 서는 간격
  const lead = 380; // 처음 다 같이 도는 시간
  const tick = (now: number) => {
    const t = now - start;
    let done = true;
    el.textContent = [...target]
      .map((ch, i) => {
        if (!/\d/.test(ch) || t > lead + i * settleEach) return ch;
        done = false;
        return String(Math.floor(Math.random() * 10));
      })
      .join('');
    if (!done) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function motion() {
  gsap.registerPlugin(ScrollTrigger, SplitText);

  // 처음 제목: 줄마다 아래에서 올라온다(열자마자 — 스크롤을 기다리지 않는다). 끝나면 나눈 줄을 되돌린다(창 크기가 바뀌어도 줄 바꿈이 다시 계산되게)
  const title = document.querySelector('.hero-title')!;
  const split = SplitText.create(title.querySelectorAll('.ht-line'), { type: 'lines', mask: 'lines' });
  document.documentElement.classList.remove('motion-wait');
  gsap.from(split.lines, { yPercent: 105, duration: 1.1, ease: 'expo.out', stagger: 0.09, delay: 0.1, onComplete: () => split.revert() });
  gsap.from('.hero-lead, .stack, .eyebrow', { y: 18, opacity: 0, duration: 0.9, ease: 'power3.out', delay: 0.55, stagger: 0.08 });
  gsap.from('.hero-phone img', { y: 80, duration: 1.4, ease: 'expo.out', delay: 0.35 });
  flap(document.querySelector<HTMLElement>('[data-flap]')!);

  // "일생을": 열리면 가는 획에서 굵은 획으로 한 번(가변 글꼴 wght 200 → 800). "기록합니다."는 스크롤에 따라 굵어진다(300 → 700)
  gsap.fromTo('[data-weight]', { fontWeight: 200 }, { fontWeight: 800, duration: 1.6, ease: 'power3.inOut', delay: 0.5 });
  gsap.fromTo('[data-weight-scroll]', { fontWeight: 300 }, { fontWeight: 700, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom 35%', scrub: true } });
  // 시리얼은 천천히 옆으로
  gsap.to('.hero-serial', { xPercent: -18, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
  gsap.to('.hero-phone', { y: -60, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });

  // 구간 제목: 줄마다 가림막 안에서 올라온다(화면에 들어올 때 한 번)
  document.querySelectorAll<HTMLElement>('.display, .pull p').forEach((h) => {
    const lines = SplitText.create(h.matches('.display') ? h.children : h, { type: 'lines', mask: 'lines' });
    gsap.from(lines.lines, { yPercent: 105, duration: 1, ease: 'expo.out', stagger: 0.08, scrollTrigger: { trigger: h, start: 'top 85%', once: true }, onComplete: () => lines.revert() });
  });
  gsap.utils.toArray<HTMLElement>('.lead, .roles div, .stat, .record-list li').forEach((el) => {
    gsap.from(el, { y: 28, opacity: 0, duration: 0.9, ease: 'power3.out', scrollTrigger: { trigger: el, start: 'top 90%', once: true } });
  });

  // 생애주기: 넓은 화면이면 구간을 고정하고 카드 줄을 가로로 민다
  const mm = gsap.matchMedia();
  mm.add('(min-width: 861px)', () => {
    const section = document.querySelector<HTMLElement>('.life')!;
    const list = document.querySelector<HTMLElement>('.life-list')!;
    section.classList.add('pinned');
    const distance = () => Math.max(0, list.scrollWidth - window.innerWidth + 40);
    gsap.to(list, {
      x: () => -distance(),
      ease: 'none',
      scrollTrigger: { trigger: section, start: 'top top', end: () => `+=${distance()}`, pin: true, scrub: 0.6, invalidateOnRefresh: true },
    });
    gsap.fromTo('.life-progress span', { scaleX: 0.12 }, { scaleX: 1, ease: 'none', scrollTrigger: { trigger: section, start: 'top top', end: () => `+=${distance()}`, scrub: true } });
    return () => section.classList.remove('pinned');
  });

  // 세 화면: 넓은 화면에서 겹친 사진이 서로 다른 속도로 움직인다(data-depth가 클수록 빨리). 좁은 화면은 흐름 배치라 움직이지 않는다
  mm.add('(min-width: 1100px)', () => {
    gsap.utils.toArray<HTMLElement>('.shot').forEach((shot) => {
      const depth = Number(shot.dataset.depth ?? 0);
      gsap.fromTo(shot, { y: depth * 300 }, { y: -depth * 300, ease: 'none', scrollTrigger: { trigger: '.screens-stage', start: 'top bottom', end: 'bottom top', scrub: true } });
    });
  });

  // 숫자: 화면에 들어오면 0에서 세어 올라간다(쉼표·소수점 자리는 그대로)
  document.querySelectorAll<HTMLElement>('[data-num], [data-count]').forEach((el) => {
    const final = el.textContent ?? '';
    const value = Number(final.replace(/,/g, ''));
    if (!Number.isFinite(value) || value === 0) return;
    const decimals = final.includes('.') ? final.split('.')[1].length : 0;
    const counter = { v: 0 };
    gsap.to(counter, {
      v: value,
      duration: 1.4,
      ease: 'power2.out',
      scrollTrigger: { trigger: el, start: 'top 88%', once: true },
      onUpdate: () => {
        el.textContent = counter.v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      },
      onComplete: () => {
        el.textContent = final;
      },
    });
  });
}

fill();
bar();
// 글꼴이 온 뒤에 줄을 나눈다(글꼴이 바뀌면 줄 바꿈 자리가 달라진다). 그동안 처음 화면 글은 숨겨 두고(.motion-wait),
// 글꼴이 1.5초 안에 오지 않으면 기다리지 않는다(느린 연결에서 빈 화면이 오래가지 않게)
if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.documentElement.classList.add('motion-wait');
  const late = new Promise((done) => setTimeout(done, 1500));
  void Promise.race([document.fonts.ready, late]).then(() => {
    try {
      motion();
      ScrollTrigger.refresh();
    } finally {
      document.documentElement.classList.remove('motion-wait'); // 움직임이 실패해도 글은 보이게
    }
  });
}
