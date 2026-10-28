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

/** 지금 단계 이름(모두 지났으면 마지막 칸) — 목록 카드의 한 줄 요약 */
export function currentStep(steps: Step[]): string {
  return (steps.find((s) => s.state === 'current') ?? steps[steps.length - 1]).label;
}
