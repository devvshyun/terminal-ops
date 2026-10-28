import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { InspectionItemView, InspectionResultInput, InspectRequest, InspectResult, TerminalDetail } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { useInspectionItems, useTerminal } from '../api/queries';
import { keys } from '../api/query-keys';
import { describeError, ErrorBox } from '../components/ErrorBox';
import { SerialFinder } from '../components/SerialFinder';
import { TERMINAL_STATUS_LABEL } from '../lib/labels';

/** 시리얼이 바뀌면(다음 단말기) 고른 값·메모를 처음으로 — key로 다시 그린다 */
export function InspectPage() {
  const serialNo = useParams().serialNo ?? '';
  return <Inspect key={serialNo} serialNo={serialNo} />;
}

/** 메모 최대 길이(api InspectionResultDto note `@Length(0, 200)`) */
const NOTE_MAX = 200;

/**
 * 단말기 한 대 검수(F13, 보강 4). 모델 체크리스트 항목마다 합격/불합격을 고르고(처음엔 비어 있다 — 안 보고 저장하지 않게), 불합격이면 메모.
 * 검수할 수 있는지는 서버가 전이 표에서 계산한 `actions.inspect`로 본다(decisions/0040). 저장은 기존 API — 하나라도 불합격이면 서버가 DEFECTIVE로 바꾼다.
 */
function Inspect({ serialNo }: { serialNo: string }) {
  const terminal = useTerminal(serialNo);
  const items = useInspectionItems(terminal.data?.actions.inspect ? terminal.data.modelCode : undefined);
  /** 저장 결과. 저장 뒤 다시 읽은 단말기는 더 이상 검수 대기가 아니므로(INSPECTED·DEFECTIVE) 결과는 여기 따로 들고 있는다 */
  const [saved, setSaved] = useState<{ result: InspectResult; labels: string[] } | null>(null);

  /** 저장 실패. 실패 뒤 다시 읽은 단말기가 검수 대기가 아니면 체크리스트가 사라지므로(그 안의 mutation 상태도 같이) 여기 따로 든다 */
  const [saveError, setSaveError] = useState<unknown>(null);

  if (saved) return <Saved serialNo={serialNo} {...saved} />;

  return (
    <section>
      <p>
        <Link to="/inspections">← 검수 대기</Link>
      </p>
      <h1 className="serial-title">{serialNo}</h1>
      <ErrorBox error={terminal.error} />
      {terminal.data ? <TerminalHead terminal={terminal.data} /> : terminal.isPending ? <p className="muted">불러오는 중…</p> : null}
      {terminal.data && !terminal.data.actions.inspect ? (
        <>
          {saveError ? <SaveFailed error={saveError} /> : null}
          <p className="notice">
            검수 대기 단말기가 아닙니다(지금 상태: {TERMINAL_STATUS_LABEL[terminal.data.status]}). 그새 다른 사람이 검수했을 수 있습니다. 다른 단말기를 스캔하세요.
          </p>
          <SerialFinder />
        </>
      ) : null}
      <ErrorBox error={items.error} />
      {terminal.data?.actions.inspect && items.data && items.data.length === 0 ? (
        <p className="notice">이 모델은 검수 항목이 없습니다. 어드민에서 확인하세요.</p>
      ) : null}
      {terminal.data?.actions.inspect && items.data && items.data.length > 0 ? (
        <Checklist serialNo={serialNo} items={items.data} onSaved={setSaved} onFailed={setSaveError} />
      ) : null}
    </section>
  );
}

function TerminalHead({ terminal }: { terminal: TerminalDetail }) {
  return (
    <p className="muted">
      {terminal.modelName}({terminal.modelCode}) · {TERMINAL_STATUS_LABEL[terminal.status]}
    </p>
  );
}

function Checklist({
  serialNo,
  items,
  onSaved,
  onFailed,
}: {
  serialNo: string;
  items: InspectionItemView[];
  onSaved: (saved: { result: InspectResult; labels: string[] }) => void;
  onFailed: (error: unknown) => void;
}) {
  const client = useQueryClient();
  const [passed, setPassed] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const inspect = useMutation({
    mutationFn: (results: InspectionResultInput[]) =>
      api<InspectResult>(`/terminals/${encodeURIComponent(serialNo)}/inspections`, { method: 'POST', body: { results } satisfies InspectRequest }),
    onSuccess: (result) => onSaved({ result, labels: items.filter((item) => result.failedItems.includes(item.code)).map((item) => item.label) }),
    onError: onFailed,
    // 다시 읽는 것은 오늘 요약·검수 대기·이 단말기뿐(검수 항목은 그대로). 실패(422 등)도 읽는다: 대개 "그새 다른 사람이 검수했다 = 화면이 낡았다"
    onSettled: () =>
      void Promise.all([keys.today, keys.queue, keys.terminal(serialNo)].map((queryKey) => client.invalidateQueries({ queryKey }))),
  });

  const done = items.every((item) => passed[item.code] !== undefined);
  const save = () =>
    inspect.mutate(
      items.map((item) => {
        const note = passed[item.code] ? '' : (notes[item.code] ?? '').trim();
        return { itemCode: item.code, passed: passed[item.code], ...(note ? { note } : {}) };
      }),
    );

  return (
    <div>
      <button type="button" onClick={() => setPassed(Object.fromEntries(items.map((item) => [item.code, true])))} disabled={inspect.isPending}>
        모두 합격
      </button>
      <ul className="checklist">
        {items.map((item) => (
          <li key={item.code}>
            <div className="check-row" role="group" aria-label={item.label}>
              <span className="check-label">{item.label}</span>
              <div className="segmented">
                <button type="button" className="pass" aria-pressed={passed[item.code] === true} onClick={() => setPassed({ ...passed, [item.code]: true })}>
                  합격
                </button>
                <button type="button" className="fail" aria-pressed={passed[item.code] === false} onClick={() => setPassed({ ...passed, [item.code]: false })}>
                  불합격
                </button>
              </div>
            </div>
            {passed[item.code] === false ? (
              <input
                aria-label={`${item.label} 메모`}
                placeholder="불합격 이유(선택)"
                maxLength={NOTE_MAX}
                value={notes[item.code] ?? ''}
                onChange={(e) => setNotes({ ...notes, [item.code]: e.target.value })}
              />
            ) : null}
          </li>
        ))}
      </ul>
      <ErrorBox error={inspect.error} />
      <button type="button" className="primary" disabled={!done || inspect.isPending} onClick={save}>
        {done ? '검수 결과 저장' : `남은 항목 ${items.filter((item) => passed[item.code] === undefined).length}개`}
      </button>
    </div>
  );
}

function SaveFailed({ error }: { error: unknown }) {
  const { title, detail } = describeError(error);
  return (
    <div className="error" role="alert">
      <strong>방금 저장하지 못했습니다: {title}</strong>
      <small className="error-detail">{detail}</small>
    </div>
  );
}

function Saved({ serialNo, result, labels }: { serialNo: string; result: InspectResult; labels: string[] }) {
  return (
    <section>
      <h1 className="serial-title">{serialNo}</h1>
      <div className={result.passed ? 'result ok' : 'result danger'} role="status">
        <strong>{result.passed ? '합격 — 검수 완료' : '불합격 — 불량으로 바뀜'}</strong>
        {labels.length ? <p>불합격 항목: {labels.join(', ')}</p> : null}
      </div>
      <Link className="big-button" to="/inspections">
        다음 단말기
      </Link>
      <SerialFinder />
    </section>
  );
}
