import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import type { RegisterTerminalRequest, RowResultCode, TerminalImportView, TerminalModelView, TerminalView } from '@terminal-ops/contracts';
import { ErrorBox } from '../components/ErrorBox';
import { csvDataUrl, importResultCsv } from '../lib/csv';
import { label, ROW_RESULT_LABEL, TERMINAL_STATUS_LABEL } from '../lib/labels';

/** 서버 규칙과 같은 시리얼 형식(api terminal/bulk-rows.ts SERIAL_NO_PATTERN) — 화면은 미리 알려 줄 뿐, 최종 판단은 서버 */
export const SERIAL_NO_PATTERN = /^[A-Z0-9-]{4,32}$/;
/** 서버 상한(api terminal.controller.ts의 파일 크기 2MB) */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

const SUCCESS = new Set<RowResultCode>(['CREATED']);

/** 올리기 전에 화면이 거를 수 있는 파일 문제(서버도 같은 것을 400 INVALID_FILE·413 FILE_TOO_LARGE로 막는다) */
export function fileProblem(file: File | null): string | null {
  if (!file) return null;
  if (!file.name.toLowerCase().endsWith('.xlsx')) return '.xlsx 파일만 올릴 수 있습니다.';
  if (file.size > MAX_IMPORT_BYTES) return '파일이 2MB를 넘습니다. 나눠서 올리세요.';
  return null;
}

/**
 * 단말기 등록(F1, 보강 5): 한 대 등록과 엑셀 일괄 등록. 둘 다 입고(RECEIVED) 상태로 들어간다.
 * 엑셀은 1행 머리글에 serialNo·modelCode 열(순서·다른 열 무관), 5,000행까지(api decisions/0022). 결과는 행 순서대로 — 실패한 행만 고쳐 다시 올린다.
 */
export function RegistrationPage() {
  const client = useQueryClient();
  const models = useQuery({ queryKey: keys.terminalModels, queryFn: () => api<TerminalModelView[]>('/terminal-models'), staleTime: Infinity });

  const [serialNo, setSerialNo] = useState('');
  const [modelCode, setModelCode] = useState('');
  const serialOk = SERIAL_NO_PATTERN.test(serialNo);
  const register = useMutation({
    mutationFn: (body: RegisterTerminalRequest) => api<TerminalView>('/terminals', { method: 'POST', body }),
    onSuccess: async () => {
      setSerialNo('');
      await client.invalidateQueries({ queryKey: keys.terminals.all });
    },
  });
  const submitOne = (event: FormEvent) => {
    event.preventDefault();
    if (serialOk && modelCode) register.mutate({ serialNo, modelCode } satisfies RegisterTerminalRequest);
  };

  const [file, setFile] = useState<File | null>(null);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const problem = fileProblem(file);
  const upload = useMutation({
    mutationFn: (f: File) => {
      const form = new FormData();
      form.append('file', f);
      return api<TerminalImportView>('/terminals/imports', { method: 'POST', body: form });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: keys.terminals.all });
    },
  });
  const result = upload.data;
  const rows = result ? result.results.filter((r) => !onlyFailed || !SUCCESS.has(r.result)) : [];

  return (
    <section>
      <h2>단말기 등록</h2>

      <form className="panel" aria-label="한 대 등록" onSubmit={submitOne}>
        <h3>한 대 등록</h3>
        <div className="row">
          <input aria-label="시리얼" placeholder="시리얼(예 SN1-000123)" value={serialNo} onChange={(e) => setSerialNo(e.target.value.trim())} />
          <select aria-label="모델" value={modelCode} onChange={(e) => setModelCode(e.target.value)}>
            <option value="">모델 선택</option>
            {models.data?.map((m) => (
              <option key={m.code} value={m.code}>
                {m.code} {m.name}
              </option>
            ))}
          </select>
          <button type="submit" className="primary" disabled={!serialOk || !modelCode || register.isPending}>
            등록
          </button>
        </div>
        {serialNo && !serialOk ? <p className="field-error">시리얼은 대문자·숫자·하이픈 4~32자입니다.</p> : null}
        <ErrorBox error={register.error} />
        {register.data ? (
          <p className="ok" role="status">
            <Link to={`/terminals/${encodeURIComponent(register.data.serialNo)}`}>{register.data.serialNo}</Link> 등록됨 ·{' '}
            {label(TERMINAL_STATUS_LABEL, register.data.status)}
          </p>
        ) : null}
      </form>

      <div className="panel" aria-label="엑셀 일괄 등록">
        <h3>엑셀 일괄 등록</h3>
        <p className="hint">.xlsx 첫 시트, 1행 머리글에 serialNo·modelCode 열. 5,000행·2MB까지. 성공한 행만 등록되고 실패한 행은 이유와 함께 돌려받습니다.</p>
        <div className="row">
          <input
            aria-label="엑셀 파일"
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              upload.reset();
            }}
          />
          <button type="button" className="primary" disabled={!file || problem !== null || upload.isPending} onClick={() => file && upload.mutate(file)}>
            {upload.isPending ? '올리는 중…' : '올리기'}
          </button>
        </div>
        {problem ? <p className="field-error">{problem}</p> : null}
        <ErrorBox error={upload.error} />
        {result ? (
          <div aria-label="등록 결과">
            <p>
              <strong>{result.fileName}</strong> · {result.total}행 ·{' '}
              {Object.entries(result.summary)
                .map(([code, n]) => `${label(ROW_RESULT_LABEL, code)} ${n}`)
                .join(', ')}
            </p>
            <div className="row">
              <label>
                <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} /> 실패한 행만
              </label>
              <a href={csvDataUrl(importResultCsv(result))} download={`${result.fileName.replace(/\.xlsx$/i, '')}-결과.csv`}>
                결과 내려받기(CSV)
              </a>
            </div>
            <table>
              <thead>
                <tr>
                  <th scope="col">행</th>
                  <th scope="col">시리얼</th>
                  <th scope="col">결과</th>
                  <th scope="col">이유</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.row}>
                    <td>{r.row}</td>
                    <td>{r.serialNo}</td>
                    <td className={SUCCESS.has(r.result) ? 'ok' : 'bad'}>{label(ROW_RESULT_LABEL, r.result)}</td>
                    <td>{r.message ?? ''}</td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      {onlyFailed ? '실패한 행이 없습니다.' : '데이터 행이 없습니다.'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </section>
  );
}
