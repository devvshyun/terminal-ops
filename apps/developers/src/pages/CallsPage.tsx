import { useSearchParams } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { BeforeIdPage, PartnerCallView, PartnerView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { CallsTable } from '../components/CallsTable';
import { ErrorBox } from '../components/ErrorBox';

/**
 * 호출 로그(보강 7, decisions/0082): 외부용 API를 부른 기록, 최근부터 50개씩 "더 보기". 업체로 거른다(주소 ?partnerId=에 남는다 — 업체 화면에서 넘어온다).
 * 키를 알아본 호출만 남는다 — 401은 어느 업체인지 몰라 없다.
 */
export function CallsPage() {
  const [params, setParams] = useSearchParams();
  const partnerId = Number(params.get('partnerId')) || undefined;
  const partners = useQuery({ queryKey: keys.partners, queryFn: () => api<PartnerView[]>('/admin/partners') });
  const list = useInfiniteQuery({
    queryKey: keys.calls({ partnerId }),
    queryFn: ({ pageParam }) => api<BeforeIdPage<PartnerCallView>>('/admin/partner-calls', { query: { partnerId, beforeId: pageParam } }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBeforeId ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <h1>호출 로그</h1>
      <p className="muted lead">외부용 API(/partner/v1)를 부른 기록입니다. 키를 알아본 호출만 남습니다 — 401(키 없음·틀림·폐기)은 남지 않습니다.</p>
      <div className="toolbar">
        <label>
          업체
          <select
            aria-label="업체"
            value={partnerId ?? ''}
            onChange={(e) => setParams(e.target.value ? { partnerId: e.target.value } : {})}
          >
            <option value="">전체</option>
            {partners.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorBox error={list.error} />
      {list.data && items.length === 0 ? <p className="empty">아직 남은 호출이 없습니다.</p> : null}
      {items.length > 0 ? <CallsTable label="호출 로그" calls={items} showPartner /> : null}
      {list.hasNextPage ? (
        <button type="button" className="more" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          더 보기
        </button>
      ) : null}
    </>
  );
}
