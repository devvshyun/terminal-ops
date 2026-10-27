import { useState, type FormEvent } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api/client';
import type { MerchantView, TerminalModelView, TerminalPage } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { formatKst } from '../lib/format';
import { label, TERMINAL_STATUS_LABEL, TERMINAL_STATUSES } from '../lib/labels';

const SIZE = 20;
const FILTERS = ['status', 'modelCode', 'merchantCode', 'q'] as const;

/**
 * 단말기 목록(F1). 조건은 주소(?status=&modelCode=&merchantCode=&q=&page=)에 둔다 — 상세에서 돌아와도 같은 목록이 보이게.
 * 페이지는 offset + 전체 수(GET /terminals, decisions/0039·실험 0013).
 */
export function TerminalListPage() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const filter = Object.fromEntries(FILTERS.map((k) => [k, params.get(k) ?? ''])) as Record<(typeof FILTERS)[number], string>;
  const [draft, setDraft] = useState(filter);

  const models = useQuery({ queryKey: ['terminal-models'], queryFn: () => api<TerminalModelView[]>('/terminal-models'), staleTime: Infinity });
  const merchants = useQuery({ queryKey: ['merchants'], queryFn: () => api<MerchantView[]>('/merchants'), staleTime: Infinity });
  const list = useQuery({
    queryKey: ['terminals', filter, page],
    queryFn: () => api<TerminalPage>('/terminals', { query: { ...filter, page, size: SIZE } }),
    placeholderData: keepPreviousData,
  });

  const search = (event: FormEvent) => {
    event.preventDefault();
    const next = new URLSearchParams();
    for (const k of FILTERS) if (draft[k].trim()) next.set(k, draft[k].trim());
    setParams(next); // 조건이 바뀌면 1쪽부터
  };
  const goto = (p: number) => {
    const next = new URLSearchParams(params);
    next.set('page', String(p));
    setParams(next);
  };
  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / SIZE)) : 1;

  return (
    <section>
      <h2>단말기</h2>
      <form className="filters" onSubmit={search}>
        <select aria-label="상태" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
          <option value="">상태 전체</option>
          {TERMINAL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {TERMINAL_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select aria-label="모델" value={draft.modelCode} onChange={(e) => setDraft({ ...draft, modelCode: e.target.value })}>
          <option value="">모델 전체</option>
          {models.data?.map((m) => (
            <option key={m.code} value={m.code}>
              {m.code} {m.name}
            </option>
          ))}
        </select>
        <select aria-label="가맹점" value={draft.merchantCode} onChange={(e) => setDraft({ ...draft, merchantCode: e.target.value })}>
          <option value="">가맹점 전체</option>
          {merchants.data?.map((m) => (
            <option key={m.code} value={m.code}>
              {m.name}
            </option>
          ))}
        </select>
        <input aria-label="시리얼 앞부분" placeholder="시리얼 앞부분" value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} />
        <button type="submit" className="primary">
          검색
        </button>
      </form>
      <ErrorBox error={list.error} />
      {list.data ? (
        <>
          <p className="muted">총 {list.data.total.toLocaleString()}대</p>
          <table>
            <thead>
              <tr>
                <th>시리얼</th>
                <th>모델</th>
                <th>상태</th>
                <th>가맹점</th>
                <th>상태가 된 시각</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((t) => (
                <tr key={t.serialNo}>
                  <td>
                    <Link to={`/terminals/${encodeURIComponent(t.serialNo)}`}>{t.serialNo}</Link>
                  </td>
                  <td>{t.modelCode}</td>
                  <td>{label(TERMINAL_STATUS_LABEL, t.status)}</td>
                  <td>{t.merchantCode ?? '-'}</td>
                  <td>{formatKst(t.statusChangedAt)}</td>
                </tr>
              ))}
              {list.data.items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    조건에 맞는 단말기가 없습니다.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <div className="row">
            <button type="button" disabled={page <= 1} onClick={() => goto(page - 1)}>
              이전
            </button>
            <span>
              {page} / {totalPages}쪽
            </span>
            <button type="button" disabled={page >= totalPages} onClick={() => goto(page + 1)}>
              다음
            </button>
          </div>
        </>
      ) : list.isPending ? (
        <p className="muted">불러오는 중</p>
      ) : null}
    </section>
  );
}
