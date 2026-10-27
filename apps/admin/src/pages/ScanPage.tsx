import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import type { BeforeIdPage } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { WriteButton } from '../components/WriteButton';
import { formatKst } from '../lib/format';

interface PurchaseOrderView {
  id: number;
  poNo: string;
  modelCode: string;
  quantity: number;
  status: string;
}

interface ScanResultView {
  scanId: string;
  kind: string;
  poNo: string | null;
  actor: string;
  replayed: boolean;
  createdAt: string;
  summary: Record<string, number>;
  results: { serialNo: string; result: string; message?: string }[];
}

/** 스캐너가 박스마다 만드는 멱등 키(서버 규칙: 영문·숫자·_·- 8~64자) */
export function newScanId(): string {
  return `BOX-${crypto.randomUUID()}`;
}

/** 붙여 넣은 글을 시리얼 목록으로: 줄·쉼표·공백으로 나누고 빈 것은 뺀다(순서는 그대로 — 서버가 행별 결과를 같은 순서로 준다) */
export function parseSerials(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 붙여 넣은 시리얼 중 앞에 이미 나온 것의 수(서버는 박스 안 중복을 행별 결과로 거절한다) */
export function countDuplicates(serials: string[]): number {
  return serials.length - new Set(serials).size;
}

/**
 * 이 오류면 같은 박스를 같은 scanId로 다시 보내면 된다(처리 중·연결 실패·5xx, 그리고 회수 박스가 다른 작업과 겹쳐 통째로 되돌려진
 * 409 VERSION_CONFLICT — 서버가 결과를 저장하지 않았으니 같은 내용을 다시 보내면 처음부터 처리한다). 그 밖(입력 오류 등)은 박스를 고쳐 새 scanId로
 */
const retryable = (error: unknown) =>
  !(error instanceof ApiError) || error.status >= 500 || (error.status === 409 && (error.code === 'SCAN_IN_PROGRESS' || error.code === 'VERSION_CONFLICT'));

/** 열린 발주 상태. 상태별로 따로 불러 합친다 — 한 번에 최근 100개를 받아 거르면 CLOSED가 쌓였을 때 오래된 열린 발주가 잘린다 */
const OPEN_PO_STATUSES = ['ORDERED', 'RECEIVING'] as const;

const SUCCESS = new Set(['CREATED', 'RETURNED']);

/**
 * 박스 일괄 스캔(F6). 박스 하나 = 요청 하나. scanId는 처음 보낼 때 만들고, 결과를 받거나 박스를 버릴 때까지 같은 값을 쓴다 —
 * 응답을 못 받아 다시 보내도 서버가 한 번만 처리하고 저장한 결과를 준다(decisions/0020). 보낸 뒤에는 목록을 고칠 수 없다
 * (같은 scanId로 다른 내용을 보내면 422 SCAN_ID_REUSED).
 */
export function ScanPage() {
  const client = useQueryClient();
  const [kind, setKind] = useState<'RECEIVE' | 'RETURN_IN'>('RECEIVE');
  const [poNo, setPoNo] = useState('');
  const [text, setText] = useState('');
  const [scanId, setScanId] = useState<string | null>(null);
  /** 지금 박스의 scanId(늦게 온 응답이 그새 바뀐 박스의 scanId를 지우지 않게 비교용) */
  const currentScanId = useRef<string | null>(null);
  const changeScanId = (id: string | null) => {
    currentScanId.current = id;
    setScanId(id);
  };

  const orders = useQuery({
    queryKey: ['purchase-orders', 'open'],
    queryFn: async () => {
      const pages = await Promise.all(
        OPEN_PO_STATUSES.map((status) => api<BeforeIdPage<PurchaseOrderView>>('/purchase-orders', { query: { status, limit: 100 } })),
      );
      return pages.flatMap((p) => p.items).sort((a, b) => b.id - a.id); // 최근 발주부터
    },
    enabled: kind === 'RECEIVE',
  });

  const scan = useMutation({
    mutationFn: (body: { scanId: string; kind: string; poNo?: string; serials: string[] }) => api<ScanResultView>('/scans', { method: 'POST', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['terminals'] });
      void client.invalidateQueries({ queryKey: ['purchase-orders'] }); // 입고로 ORDERED → RECEIVING
    },
    onError: (error, body) => {
      // 내용을 고쳐야 하는 오류: 다음 보내기는 새 scanId. 그새 다른 박스로 넘어갔으면 그 박스의 scanId는 건드리지 않는다
      if (!retryable(error) && currentScanId.current === body.scanId) changeScanId(null);
    },
  });

  const serials = parseSerials(text);
  const duplicates = countDuplicates(serials);
  const locked = scanId !== null; // 보냈거나 보내는 중인 박스는 고치지 않는다
  const result = scan.data;
  const send = () => {
    const id = scanId ?? newScanId();
    changeScanId(id);
    scan.mutate({ scanId: id, kind, ...(kind === 'RECEIVE' ? { poNo } : {}), serials });
  };
  const nextBox = () => {
    // 보냈는데 결과를 못 받은 박스: 서버가 처리했을 수도 있다. 버리면 같은 scanId로 확인할 방법이 없어진다
    if (scanId !== null && result === undefined && !window.confirm('결과를 받지 못한 박스입니다. 버리시겠습니까? 서버가 이미 처리했을 수 있습니다 — 같은 scanId로 다시 보내면 저장된 결과를 받습니다.')) {
      return;
    }
    changeScanId(null);
    setText('');
    scan.reset();
  };
  const conflict = scan.error instanceof ApiError && scan.error.isVersionConflict;

  return (
    <section>
      <h2>박스 스캔</h2>
      <div className="row" role="radiogroup" aria-label="스캔 종류">
        <label>
          <input type="radio" checked={kind === 'RECEIVE'} disabled={locked} onChange={() => setKind('RECEIVE')} /> 발주분 입고
        </label>
        <label>
          <input type="radio" checked={kind === 'RETURN_IN'} disabled={locked} onChange={() => setKind('RETURN_IN')} /> 회수 입고
        </label>
      </div>
      {kind === 'RECEIVE' ? (
        <div className="row">
          <select aria-label="발주" value={poNo} disabled={locked} onChange={(e) => setPoNo(e.target.value)}>
            <option value="">발주 선택</option>
            {orders.data?.map((p) => (
              <option key={p.poNo} value={p.poNo}>
                {p.poNo} {p.modelCode} {p.quantity}대 ({p.status})
              </option>
            ))}
          </select>
          <ErrorBox error={orders.error} />
        </div>
      ) : null}
      <textarea
        aria-label="시리얼"
        rows={10}
        placeholder="시리얼을 한 줄에 하나씩 스캔하거나 붙여 넣으세요"
        value={text}
        readOnly={locked}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row">
        <span>{serials.length}개</span>
        {duplicates > 0 ? <span className="field-error">중복 {duplicates}개</span> : null}
        {scanId ? <code aria-label="scanId">{scanId}</code> : null}
        <WriteButton
          className="primary"
          disabled={serials.length === 0 || serials.length > 500 || (kind === 'RECEIVE' && !poNo) || scan.isPending || result !== undefined}
          onClick={send}
        >
          {scanId && scan.isError ? '같은 scanId로 다시 보내기' : '보내기'}
        </WriteButton>
        <button type="button" disabled={scan.isPending} onClick={nextBox}>
          새 박스
        </button>
        {serials.length > 500 ? <span className="field-error">한 박스는 500개까지입니다.</span> : null}
      </div>
      <ErrorBox error={scan.error} />
      {conflict ? <p className="muted">다른 작업과 겹쳐 이 박스 전체가 되돌려졌습니다(처리된 것 없음). 같은 scanId로 다시 보내세요.</p> : null}
      {result ? (
        <div className="panel">
          <h3>
            결과 {result.replayed ? <span className="badge">이미 처리된 박스 — 저장된 결과</span> : null}
          </h3>
          <p className="muted">
            {result.kind === 'RECEIVE' ? `발주 ${result.poNo} 입고` : '회수 입고'} · {result.actor} · {formatKst(result.createdAt)}
          </p>
          <p>
            {Object.entries(result.summary)
              .map(([code, n]) => `${code} ${n}`)
              .join(', ')}
          </p>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>시리얼</th>
                <th>결과</th>
                <th>이유</th>
              </tr>
            </thead>
            <tbody>
              {result.results.map((r, i) => (
                <tr key={`${r.serialNo}-${i}`}>
                  <td>{i + 1}</td>
                  <td>{r.serialNo}</td>
                  <td className={SUCCESS.has(r.result) ? 'ok' : 'bad'}>{r.result}</td>
                  <td>{r.message ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
