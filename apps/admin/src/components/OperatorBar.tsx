import { useState, type FormEvent } from 'react';
import { setOperator, useOperator } from '../operator';

/** 화면 위쪽 작업자 이름 입력. 저장하면 이후 모든 요청의 X-Operator가 된다 */
export function OperatorBar() {
  const operator = useOperator();
  const [draft, setDraft] = useState(operator);
  const [problem, setProblem] = useState<string | null>(null);

  const save = (event: FormEvent) => {
    event.preventDefault();
    setProblem(setOperator(draft));
  };

  return (
    <form className="operator" onSubmit={save}>
      <label>
        작업자{' '}
        <input aria-label="작업자 이름" value={draft} maxLength={60} placeholder="이름" onChange={(e) => setDraft(e.target.value)} />
      </label>
      <button type="submit">저장</button>
      <span className={operator ? 'operator-now' : 'operator-missing'}>{operator ? `지금: ${operator}` : '작업자 이름이 없으면 바꾸는 버튼이 꺼집니다'}</span>
      {problem ? <span className="field-error">{problem}</span> : null}
    </form>
  );
}
