import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { keys } from '../api/query-keys';
import { type AppKey, appUrl } from '../lib/apps';
import { markDone, useProgress } from '../lib/progress';
import { registerRunner } from '../replay/runners';
import { getReplay } from '../replay/runtime';
import { useTourStep } from '../replay/tour';
import { useMe } from '../session';
import { ErrorBox } from './ErrorBox';

/**
 * 단계 카드(보강 10): 번호 · 누가 · 설명 · 실행(또는 화면 열기) · 바로 옆 결과. Stripe Shell의 "설명 + 실행 + 응답"과
 * 대화형 시연의 짧은 흐름을 따른다. "끝냄"은 이 브라우저에만 남는다(lib/progress.ts).
 */
export function Step({ stepKey, n, title, who, children, actions, result }: { stepKey: string; n: string; title: string; who: string; children: ReactNode; actions?: ReactNode; result?: ReactNode }) {
  const done = useProgress().has(stepKey);
  // 자동 재생이 비추는 단계(녹화 재생본) — 테두리로 표시하고 화면 가운데로 옮긴다
  const current = useTourStep() === stepKey;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (current) ref.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }, [current]);
  return (
    <section ref={ref} className={['step', done ? 'done' : '', current ? 'tour-current' : ''].filter(Boolean).join(' ')} aria-label={title} data-step={stepKey}>
      <header>
        <span className="step-n">{n}</span>
        <div className="step-head">
          <h2>{title}</h2>
          <small className="muted">{who}</small>
        </div>
        <label className="done-box">
          <input type="checkbox" checked={done} onChange={(e) => markDone(stepKey, e.target.checked)} />
          끝냄
        </label>
      </header>
      <div className="step-body">
        <div className="step-text">
          {children}
          {actions ? <div className="step-actions">{actions}</div> : null}
        </div>
        {result ? <div className="step-result">{result}</div> : null}
      </div>
    </section>
  );
}

/** 실행은 운영자만(decisions/0092) — 그 밖이면 꺼진 단추와 안내 */
export function useCanRun(): { ok: boolean; reason: string | null } {
  const me = useMe();
  if (!me) return { ok: false, reason: '운영자로 로그인하면 실행할 수 있습니다' };
  if (me.role !== 'OPERATOR') return { ok: false, reason: `실행은 운영자(operator)만 — 지금은 ${me.displayName}` };
  return { ok: true, reason: null };
}

/**
 * 실행 단추. 끝나면 그 단계를 끝냄으로 표시하고 결과 패널을 모두 다시 읽는다(keys.all). onRun이 돌려준 글자를 단추 옆에 보인다.
 * needsLogin이 false면(가상 업체·시뮬레이터 손잡이 — 로그인 없는 서버) 로그인 없이도 누를 수 있다. markStep이 false면 끝냄으로 표시하지 않는다(그 단계의 준비 동작).
 */
export function Run({ label, stepKey, onRun, needsLogin = true, markStep = true }: { label: string; stepKey: string; onRun: () => Promise<string | void>; needsLogin?: boolean; markStep?: boolean }) {
  const client = useQueryClient();
  const can = useCanRun();
  const [message, setMessage] = useState<string | null>(null);
  const run = useMutation({
    // 녹화 재생본: 녹화 시계를 이 실행의 시각으로 옮기고, 끝나면(성공·실패 모두) 그 실행이 끝난 때로(decisions/0094)
    mutationFn: async () => {
      const replay = getReplay();
      if (!replay) return onRun();
      if (!replay.startRun(stepKey, label)) throw new Error('녹화본에서 이 실행은 이미 썼습니다(녹화한 횟수만큼만 누를 수 있어요). 위의 "처음 상태로"를 누르면 처음부터 다시 볼 수 있습니다.');
      try {
        return await onRun();
      } finally {
        replay.endRun();
      }
    },
    onMutate: () => setMessage(null),
    onSuccess: (m) => {
      if (m) setMessage(m);
      if (markStep) markDone(stepKey);
      void client.invalidateQueries({ queryKey: keys.all });
    },
  });
  const allowed = !needsLogin || can.ok;
  // 자동 재생이 이 단추를 찾아 누르게 등록한다(녹화 재생본에서만 쓰인다). 최신 상태는 ref로
  const latest = useRef({ allowed, pending: run.isPending, mutateAsync: run.mutateAsync });
  latest.current = { allowed, pending: run.isPending, mutateAsync: run.mutateAsync };
  useEffect(
    () =>
      registerRunner(stepKey, {
        label,
        enabled: () => latest.current.allowed && !latest.current.pending,
        run: () => latest.current.mutateAsync().catch(() => undefined),
      }),
    [stepKey, label],
  );
  return (
    <div className="run">
      <button type="button" className="primary" disabled={!allowed || run.isPending} onClick={() => run.mutate()}>
        {run.isPending ? '실행 중…' : `실행: ${label}`}
      </button>
      {!allowed ? <small className="muted">{can.reason}</small> : null}
      {message ? <span className="ok-text">{message}</span> : null}
      <ErrorBox error={run.error} />
    </div>
  );
}

/**
 * 그 앱 화면을 새 탭으로. 녹화 재생본에서는 녹화할 때 찍은 그 화면 사진(지금 녹화 시각 이전의 마지막 것)을 카드 안에 바로 보인다 — 누르면 크게.
 * compact면(왼쪽 "다른 화면") 사진 대신 링크만
 */
export function Open({ app, path = '/', label, compact = false }: { app: AppKey; path?: string; label: string; compact?: boolean }) {
  const replay = getReplay();
  if (replay) {
    const shot = replay.shot(`${app}:${path}`);
    if (!shot) return <small className="muted">{label} — 녹화본에는 이 화면 사진이 없습니다</small>;
    const href = `${import.meta.env.BASE_URL}shots/${shot.file}`;
    if (compact) {
      return (
        <a className="open" href={href} target="_blank" rel="noreferrer" title={shot.title}>
          {label} (녹화 사진) ↗
        </a>
      );
    }
    return (
      <figure className="shot">
        <a href={href} target="_blank" rel="noreferrer" aria-label={`${label} (녹화 사진 크게 보기)`}>
          <img src={href} alt={shot.title} loading="lazy" />
        </a>
        <figcaption>{shot.title} · 녹화할 때 찍은 화면</figcaption>
      </figure>
    );
  }
  return (
    <a className="open" href={appUrl(app, path)} target="_blank" rel="noreferrer">
      {label} ↗
    </a>
  );
}
