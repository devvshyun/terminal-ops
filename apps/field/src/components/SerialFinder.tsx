import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';

/**
 * 시리얼을 스캔(키보드 웨지 + Enter)하거나 쳐서 그 단말기 검수 화면으로 가는 입력칸(보강 4). 초점이 먼저 와 있어 바로 찍는다.
 * 검수 대기 목록 위, 검수 대기가 아닌 안내, 저장 결과 화면에 같은 것을 둔다 — 스캐너가 어느 화면에서든 갈 곳이 있게.
 */
export function SerialFinder() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState('');
  const find = (event: FormEvent) => {
    event.preventDefault();
    const serial = draft.trim();
    if (serial) navigate(`/inspections/${encodeURIComponent(serial)}`);
  };
  return (
    <form className="scan-input" onSubmit={find}>
      <label>
        시리얼 스캔으로 찾기
        <input
          autoFocus
          value={draft}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          enterKeyHint="go"
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      <button type="submit" disabled={!draft.trim()}>
        찾기
      </button>
    </form>
  );
}
