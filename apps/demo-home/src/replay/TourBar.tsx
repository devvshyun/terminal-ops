import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { markDone, resetProgress } from '../lib/progress';
import { forgetAll } from '../lib/memo';
import { findRunner } from './runners';
import { getReplay } from './runtime';
import { TOUR, tour, useTour, type TourStep } from './tour';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** cancelled()가 true가 되면 멈춘다(일시정지·다음·그만) */
async function wait(ms: number, cancelled: () => boolean) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cancelled()) return false;
    await sleep(100);
  }
  return !cancelled();
}

/**
 * 한 단계 진행: 그 막으로 → (실행이 있으면) 단추가 뜨고 켜지기를 기다려 누름 → (waitClock이면) 녹화 시계가 다음 실행 앞까지 흐르기를 기다림 → 자막 읽을 시간.
 * ran: 일시정지 뒤 다시 이어도 같은 실행을 두 번 누르지 않게
 */
async function play(s: TourStep, navigate: (to: string) => void, ran: Set<number>, index: number, cancelled: () => boolean) {
  navigate(`/act/${s.act}`);
  if (s.run && !ran.has(index)) {
    const until = Date.now() + 15000;
    let runner = findRunner(s.step, s.run);
    while (!(runner && runner.enabled()) && Date.now() < until) {
      if (cancelled()) return false;
      await sleep(150);
      runner = findRunner(s.step, s.run);
    }
    if (cancelled()) return false;
    if (runner && runner.enabled()) {
      ran.add(index);
      if (!(await wait(900, cancelled))) return false; // 단추가 강조된 것을 보고 누르게
      await runner.run();
    }
  }
  if (s.waitClock) {
    const replay = getReplay();
    const until = Date.now() + 40000;
    while (replay && !replay.waiting() && Date.now() < until) {
      if (cancelled()) return false;
      await sleep(200);
    }
  }
  if (!(await wait(s.dwell ?? 4500, cancelled))) return false;
  markDone(s.step); // 보기만 하는 단계도 끝냄으로 — 다 보면 22/22
  return true;
}

/** 화면 아래 자동 재생 막대: 자막 · n/22 · 일시정지/계속 · 다음 · 직접 해 보기. 진행 고리도 여기서 돈다 */
export function TourBar() {
  const { status, index } = useTour();
  const navigate = useNavigate();
  const client = useQueryClient();
  const ran = useRef(new Set<number>());
  // navigate는 주소가 바뀔 때마다 새 함수다 — 의존성에 넣으면 막이 바뀔 때마다 진행이 처음부터 다시 시작됐다(브라우저 리허설에서 찾음)
  const nav = useRef(navigate);
  nav.current = navigate;

  useEffect(() => {
    if (status !== 'playing') return;
    let cancelled = false;
    void play(TOUR[index]!, (to) => nav.current(to), ran.current, index, () => cancelled).then((finished) => {
      if (finished && !cancelled) tour.next();
    });
    return () => {
      cancelled = true;
    };
  }, [status, index]);

  if (status === 'idle') return null;
  const step = TOUR[index]!;
  const freePlay = () => {
    tour.stop();
    ran.current.clear();
    resetProgress();
    forgetAll();
    getReplay()?.reset();
    void client.invalidateQueries();
    navigate('/act/1');
  };
  return (
    <div className="tour-bar" role="region" aria-label="자동 재생">
      {status === 'done' ? (
        <p className="tour-caption">
          <strong>시연 끝.</strong> 이제 아무 막·단계나 직접 실행해 볼 수 있습니다(녹화를 처음 상태로 되돌립니다).
        </p>
      ) : (
        <p className="tour-caption">
          <span className="tour-n">
            {step.act}막 · {index + 1}/{TOUR.length}
          </span>
          {step.caption}
        </p>
      )}
      <div className="tour-ctl">
        {status === 'playing' ? (
          <button type="button" onClick={tour.pause}>
            일시정지
          </button>
        ) : null}
        {status === 'paused' ? (
          <button type="button" onClick={tour.resume}>
            계속
          </button>
        ) : null}
        {status !== 'done' ? (
          <button type="button" onClick={tour.next}>
            다음 ›
          </button>
        ) : null}
        <button type="button" className="primary" onClick={freePlay}>
          직접 해 보기
        </button>
      </div>
    </div>
  );
}

/** 자동 재생 시작(소개 페이지의 단추): 녹화 시계·진행 표시를 처음으로 */
export function startTour() {
  resetProgress();
  forgetAll();
  getReplay()?.reset();
  tour.start();
}
