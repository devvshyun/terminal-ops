import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../../api/client';
import { ErrorBox } from '../../components/ErrorBox';
import { MoreButton } from '../../components/MoreButton';
import { WriteButton } from '../../components/WriteButton';
import { formatKst } from '../../lib/format';
import { label, TERMINAL_STATUS_LABEL } from '../../lib/labels';
import { keys } from '../../api/query-keys';

interface AnomalyRuleView {
  rule: string;
  label: string;
  days: number | null;
}

interface AnomalyView {
  id: number;
  serialNo: string | null;
  status: string | null;
  rule: string;
  ruleLabel: string;
  detectedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  detail: { days?: number };
}

interface ScanSummary {
  detected: number;
  continuing: number;
  resolved: number;
  newSerials: string[];
}

/** 이상 단말기(F4): 규칙·열림으로 거르고 afterId로 이어 본다(서버 목록은 오름차순 키셋, decisions/0033). 바로 찾기는 동기(decisions/0038) */
export function AnomaliesPage() {
  const client = useQueryClient();
  const [rule, setRule] = useState('');
  const [open, setOpen] = useState('true');
  const rules = useQuery({ queryKey: keys.anomalyRules, queryFn: () => api<AnomalyRuleView[]>('/anomaly-rules'), staleTime: Infinity });
  const list = useInfiniteQuery({
    queryKey: keys.anomalies.list(rule, open),
    queryFn: ({ pageParam }) =>
      api<{ items: AnomalyView[]; nextAfterId: number | null }>('/anomalies', { query: { rule, open, afterId: pageParam ?? undefined, limit: 100 } }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextAfterId,
  });
  const scan = useMutation({
    mutationFn: () => api<ScanSummary>('/anomaly-scans', { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.anomalies.all }),
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section>
      <h2>이상 단말기</h2>
      <div className="filters">
        <select aria-label="규칙" value={rule} onChange={(e) => setRule(e.target.value)}>
          <option value="">규칙 전체</option>
          {rules.data?.map((r) => (
            <option key={r.rule} value={r.rule}>
              {r.label}
              {r.days === null ? '' : ` (${r.days}일)`}
            </option>
          ))}
        </select>
        <select aria-label="열림" value={open} onChange={(e) => setOpen(e.target.value)}>
          <option value="true">열린 것</option>
          <option value="false">닫힌 것</option>
          <option value="">전체</option>
        </select>
        <WriteButton disabled={scan.isPending} onClick={() => scan.mutate()}>
          {scan.isPending ? '찾는 중' : '지금 찾기'}
        </WriteButton>
      </div>
      {scan.data ? (
        <p role="status">
          새로 {scan.data.detected}건, 계속 {scan.data.continuing}건, 풀림 {scan.data.resolved}건
        </p>
      ) : null}
      <ErrorBox error={list.error ?? scan.error} />
      <table>
        <thead>
          <tr>
            <th scope="col">단말기</th>
            <th scope="col">지금 상태</th>
            <th scope="col">규칙</th>
            <th scope="col">처음 걸림</th>
            <th scope="col">마지막 확인</th>
            <th scope="col">풀림</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id}>
              <td>{a.serialNo ? <Link to={`/terminals/${encodeURIComponent(a.serialNo)}`}>{a.serialNo}</Link> : '(지워진 단말기)'}</td>
              <td>{label(TERMINAL_STATUS_LABEL, a.status)}</td>
              <td>
                {a.ruleLabel}
                {a.detail.days === undefined ? '' : ` · ${a.detail.days}일`}
              </td>
              <td>{formatKst(a.detectedAt)}</td>
              <td>{formatKst(a.lastSeenAt)}</td>
              <td>{formatKst(a.resolvedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <MoreButton hasNextPage={list.hasNextPage} isFetchingNextPage={list.isFetchingNextPage} fetchNextPage={list.fetchNextPage} />
    </section>
  );
}
