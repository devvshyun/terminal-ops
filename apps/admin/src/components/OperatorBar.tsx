import { useState, type FormEvent } from 'react';
import { setOperator, useOperator } from '../operator';

/**
 * 화면 위쪽 작업자 이름 입력. 저장하면 이후 모든 요청의 X-Operator가 된다.
 * 다른 탭이 이름을 바꾸면(storage 이벤트) 입력칸도 따라간다 — 단, 고치는 중(입력이 마지막으로 맞춘 이름과 다름)이면 입력을 덮어쓰지 않는다.
 * 따라가지 않으면 옛 이름이 남은 입력칸에서 "저장"을 눌러 이름을 되돌리게 된다(Day 6 최종 리뷰 Minor 8).
 * effect 대신 렌더 중에 맞춘다(React "props가 바뀔 때 state 조정" 방식) — effect면 한 번은 옛 값으로 그린 뒤 고친다.
 */
export function OperatorBar() {
  const operator = useOperator();
  const [draft, setDraft] = useState(operator);
  /** 입력칸을 마지막으로 맞춘 이름. draft가 이것과 같으면 고치는 중이 아니다 */
  const [synced, setSynced] = useState(operator);
  const [problem, setProblem] = useState<string | null>(null);
  if (operator !== synced) {
    setSynced(operator);
    if (draft === synced) setDraft(operator);
  }

  const save = (event: FormEvent) => {
    event.preventDefault();
    setProblem(setOperator(draft));
  };

  return (
    <form className="operator" onSubmit={save}>
      <label>
        작업자{' '}
        <input aria-label="작업자 이름" value={draft} maxLength={50} placeholder="이름" onChange={(e) => setDraft(e.target.value)} />
      </label>
      <button type="submit">저장</button>
      <span className={operator ? 'operator-now' : 'operator-missing'}>{operator ? `지금: ${operator}` : '작업자 이름이 없으면 바꾸는 버튼이 꺼집니다'}</span>
      {problem ? <span className="field-error">{problem}</span> : null}
    </form>
  );
}
