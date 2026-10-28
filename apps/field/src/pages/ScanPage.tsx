import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateScanRequest, ScanKind, ScanView } from '@terminal-ops/contracts';
import { api, ApiError } from '../api/client';
import { useOpenOrders } from '../api/queries';
import { keys } from '../api/query-keys';
import { ErrorBox } from '../components/ErrorBox';
import { lineProblem, MAX_BOX, newScanId, RESULT_LABEL, retryable, splitSerials, SUCCESS } from '../lib/scan';

const PROBLEM_LABEL = { DUPLICATE: '중복', FORMAT: '형식 오류' } as const;

/**
 * 박스 스캔(F6, 보강 4 decisions/0064). 박스 하나 = 요청 하나.
 * - 입력: 바코드 스캐너(키보드 웨지 — 시리얼을 글자로 치고 Enter)와 손 입력이 같은 칸이다. Enter마다 목록 끝에 쌓이고 입력칸은 비고 초점은 그대로라
 *   다음 바코드를 바로 찍는다. 여러 개를 붙여 넣으면 바로 목록에 쌓인다. 중복·형식 오류는 그 줄에 바로 표시한다(서버도 같은 이유로 행을 거절한다).
 * - 멱등: scanId는 처음 보낼 때 만들고 결과를 받거나 박스를 버릴 때까지 같은 값을 쓴다. 보낸 박스는 고칠 수 없다(같은 scanId에 다른 내용 → 422).
 *   어드민 ScanPage와 같은 규칙(decisions/0020·0041 Task 6).
 */
export function ScanPage() {
  const client = useQueryClient();
  const [kind, setKind] = useState<ScanKind>('RECEIVE');
  const [poNo, setPoNo] = useState('');
  const [serials, setSerials] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [scanId, setScanId] = useState<string | null>(null);
  /** 지금 박스의 scanId(늦게 온 응답이 그새 바뀐 박스의 scanId를 지우지 않게 비교용) */
  const currentScanId = useRef<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const newBox = useRef<HTMLButtonElement>(null);
  /** 잠긴 박스에 스캐너가 찍으면 켜는 안내(결과가 있으면 안내는 늘 보인다) */
  const [lockedHint, setLockedHint] = useState(false);
  const changeScanId = (id: string | null) => {
    currentScanId.current = id;
    setScanId(id);
  };

  const orders = useOpenOrders(kind === 'RECEIVE');
  const scan = useMutation({
    mutationFn: (body: CreateScanRequest) => api<ScanView>('/scans', { method: 'POST', body }),
    // 스캔은 단말기 상태·발주 입고 수·검수 대기·오늘 요약을 바꾼다 — 현장 화면의 모든 조회를 다시 읽는다
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.all }),
    onError: (error, body) => {
      // 내용을 고쳐야 하는 오류: 다음 보내기는 새 scanId. 그새 다른 박스로 넘어갔으면 그 박스의 scanId는 건드리지 않는다
      // 늦게 온 오류는 지금 박스의 scanId일 때만 scanId를 버린다(ref 비교). 새 박스를 시작한 뒤 이전 요청의 오류가 새 박스를 건드리지 않게 하는 방어다 —
      // 보내는 중에는 "새 박스"가 꺼져 있어 화면으로는 이 순서를 만들 수 없어 테스트하지 않는다(코드로만 지킨다, decisions/0064)
      if (!retryable(error) && currentScanId.current === body.scanId) changeScanId(null);
    },
  });

  const locked = scanId !== null; // 보냈거나 보내는 중인 박스는 고치지 않는다
  const result = scan.data;
  const sealed = result !== undefined; // 결과를 받은 박스: 다음은 새 박스로

  // 결과가 오면 초점을 새 박스로 — 스캐너 글자가 닫힌 박스에 조용히 버려지지 않게(같은 박스 다시 보내기에 Enter가 닿지 않게도)
  useEffect(() => {
    if (sealed) newBox.current?.focus();
  }, [sealed]);
  // 고른 발주가 다시 읽은 열린 발주에서 빠졌으면(마감) 비운다. 보낸(잠긴) 박스의 발주는 다시 보내기 때문에 건드리지 않는다
  useEffect(() => {
    if (orders.data && !locked && poNo && !orders.data.items.some((p) => p.poNo === poNo)) setPoNo('');
  }, [orders.data, locked, poNo]);
  const problems = serials.map((_, i) => lineProblem(serials, i));
  const duplicates = problems.filter((p) => p === 'DUPLICATE').length;
  const badFormat = problems.filter((p) => p === 'FORMAT').length;

  const append = (added: string[]) => {
    if (locked || added.length === 0) return;
    setSerials((list) => [...list, ...added]);
    setDraft('');
  };
  const add = (event: FormEvent) => {
    event.preventDefault(); // 스캐너의 Enter = 이 폼 제출. 입력칸은 비우고 초점은 그대로(다음 바코드)
    append(splitSerials(draft));
  };
  /** 여러 개를 붙여 넣으면 바로 목록으로 — 한 줄 입력칸은 붙여 넣은 줄바꿈을 지워 시리얼이 한 덩어리로 붙는다(사전 검증) */
  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text');
    if (!/[\s,]/.test(text.trim())) return; // 시리얼 하나는 보통 붙여 넣기(그 뒤 Enter)
    event.preventDefault();
    const { selectionStart, selectionEnd } = event.currentTarget;
    const start = selectionStart ?? draft.length;
    append(splitSerials(draft.slice(0, start) + text + draft.slice(selectionEnd ?? start)));
  };
  const remove = (index: number) => setSerials((list) => list.filter((_, i) => i !== index));
  const send = () => {
    const id = scanId ?? newScanId();
    changeScanId(id);
    scan.mutate({ scanId: id, kind, ...(kind === 'RECEIVE' ? { poNo } : {}), serials });
  };
  const nextBox = () => {
    // 보냈는데 결과를 못 받은 박스: 서버가 처리했을 수도 있다. 버리면 같은 scanId로 확인할 방법이 없어진다
    if (scanId !== null && result === undefined && !window.confirm('결과를 받지 못한 박스입니다. 버리시겠습니까? 서버가 이미 처리했을 수 있습니다 — 같은 박스 다시 보내기를 누르면 저장된 결과를 받습니다.')) {
      return;
    }
    changeScanId(null);
    setSerials([]);
    setDraft('');
    scan.reset();
    setLockedHint(false);
    input.current?.focus();
  };
  /** 잠긴 입력칸은 폼이 제출되지 않는다(추가 버튼이 꺼져 있다) — Enter를 직접 받아 안내한다 */
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && locked) {
      event.preventDefault();
      setLockedHint(true);
    }
  };
  const succeeded = result?.results.filter((r) => SUCCESS.has(r.result)).length ?? 0;
  const conflict = scan.error instanceof ApiError && scan.error.code === 'VERSION_CONFLICT';

  return (
    <section>
      <h1>박스 스캔</h1>
      <div className="segmented" role="group" aria-label="스캔 종류">
        <button type="button" aria-pressed={kind === 'RECEIVE'} disabled={locked} onClick={() => {
            setKind('RECEIVE');
            input.current?.focus();
          }}>
          발주분 입고
        </button>
        <button type="button" aria-pressed={kind === 'RETURN_IN'} disabled={locked} onClick={() => {
            setKind('RETURN_IN');
            input.current?.focus();
          }}>
          회수 입고
        </button>
      </div>
      {kind === 'RECEIVE' ? (
        <label>
          발주
          <select value={poNo} disabled={locked} onChange={(e) => {
              setPoNo(e.target.value);
              input.current?.focus(); // 스캐너 글자가 select에 가면 type-ahead로 발주가 바뀐다
            }}>
            <option value="">발주 선택</option>
            {orders.data?.items.map((p) => (
              <option key={p.poNo} value={p.poNo}>
                {p.poNo} {p.modelCode} {p.quantity}대
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <ErrorBox error={orders.error} />
      {kind === 'RECEIVE' && orders.data?.truncated ? <p className="muted">열린 발주가 많아 최근 발주만 보입니다(상태별 최근 100개). 없는 발주는 어드민에서 확인하세요.</p> : null}

      <form className="scan-input" onSubmit={add}>
        <label>
          시리얼 (스캐너로 찍거나 입력 후 Enter)
          <input
            ref={input}
            autoFocus
            value={draft}
            readOnly={locked}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            enterKeyHint="enter"
            onChange={(e) => setDraft(e.target.value)}
            onPaste={paste}
            onKeyDown={keyDown}
          />
        </label>
        <button type="submit" disabled={locked || !draft.trim()}>
          추가
        </button>
      </form>

      <p className="box-count" aria-live="polite">
        <strong>{serials.length}개</strong>
        {duplicates > 0 ? <span className="bad"> · 중복 {duplicates}</span> : null}
        {badFormat > 0 ? <span className="bad"> · 형식 오류 {badFormat}</span> : null}
        {serials.length > MAX_BOX ? <span className="bad"> · 한 박스는 {MAX_BOX}개까지입니다</span> : null}
      </p>

      <ol className="box-list" aria-label="박스 목록">
        {serials.map((serial, i) => {
          const row = result?.results[i];
          const problem = problems[i];
          return (
            <li key={`${serial}-${i}`}>
              <span className="serial">{serial}</span>
              {row ? (
                <span className={SUCCESS.has(row.result) ? 'badge ok' : 'badge danger'} title={row.message}>
                  {RESULT_LABEL[row.result]}
                </span>
              ) : problem ? (
                <span className="badge danger">{PROBLEM_LABEL[problem]}</span>
              ) : null}
              {!locked ? (
                <button type="button" className="link" aria-label={`${serial} 빼기`} onClick={() => remove(i)}>
                  빼기
                </button>
              ) : null}
              {row?.message ? <small className="row-message">{row.message}</small> : null}
            </li>
          );
        })}
      </ol>

      <ErrorBox error={scan.error} />
      {conflict ? <p className="muted">다른 작업과 겹쳐 이 박스 전체가 되돌려졌습니다(처리된 것 없음). 같은 박스를 다시 보내세요.</p> : null}
      {result ? (
        <div className="notice" role="status">
          {result.replayed ? <strong>이미 처리된 박스 — 저장된 결과입니다. </strong> : null}
          {result.kind === 'RECEIVE' ? `발주 ${result.poNo} 입고` : '회수 입고'}: 성공 {succeeded} · 거절 {result.results.length - succeeded}
        </div>
      ) : null}
      {sealed || lockedHint ? (
        <p className="notice" role="note">
          새 박스를 눌러야 다음을 찍을 수 있습니다.
        </p>
      ) : null}
      {scanId ? (
        <p className="muted small">
          박스 번호 <code aria-label="scanId">{scanId}</code>
        </p>
      ) : null}

      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={serials.length === 0 || serials.length > MAX_BOX || (kind === 'RECEIVE' && !poNo) || scan.isPending || result !== undefined}
          onClick={send}
        >
          {scanId && scan.isError ? '같은 박스 다시 보내기' : '보내기'}
        </button>
        <button ref={newBox} type="button" disabled={scan.isPending} onClick={nextBox}>
          새 박스
        </button>
      </div>
    </section>
  );
}
