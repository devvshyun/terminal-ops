import type { Step } from '../lib/steps';

/** 진행 단계를 위에서 아래로(휴대폰 폭에서 가로 막대는 글자가 잘린다). 지금 단계는 aria-current="step" */
export function StepList({ steps, label }: { steps: Step[]; label: string }) {
  return (
    <ol className="steps" aria-label={label}>
      {steps.map((s) => (
        <li key={s.label} className={s.state} aria-current={s.state === 'current' ? 'step' : undefined}>
          {s.label}
        </li>
      ))}
    </ol>
  );
}

/**
 * 진행 막대(가로): 목록 카드에 붙이는 그림. 글자 요약("지금 단계: …", 운송장 한 줄)이 따로 있으므로 스크린 리더에는 숨긴다(decisions/0077).
 * labels를 켜면 칸 아래에 단계 이름을 작게 — 칸이 다섯 개 이하일 때만 쓴다(휴대폰 폭에서 글자가 잘리지 않게).
 */
export function StepBar({ steps, labels = false }: { steps: Step[]; labels?: boolean }) {
  return (
    <div className={labels ? 'step-bar labeled' : 'step-bar'} aria-hidden="true">
      {steps.map((s) => (
        <span key={s.label} className={s.state}>
          {labels ? s.label : null}
        </span>
      ))}
    </div>
  );
}

/** 지금 단계 이름(모두 지났으면 마지막 칸) — 목록 카드의 한 줄 요약 */
export function currentStep(steps: Step[]): string {
  return (steps.find((s) => s.state === 'current') ?? steps[steps.length - 1]).label;
}
