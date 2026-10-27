import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { itemsOf, useBeforeIdList } from '../../api/lists';
import type { TerminalModelView } from '../../api/types';
import { ErrorBox } from '../../components/ErrorBox';
import { MoreButton } from '../../components/MoreButton';
import { WriteButton } from '../../components/WriteButton';
import { formatKst } from '../../lib/format';

interface PurchaseOrderView {
  id: number;
  poNo: string;
  modelCode: string;
  quantity: number;
  status: string;
  orderedBy: string;
  createdAt: string;
  closedAt: string | null;
  closedBy: string | null;
}

interface Reconciliation {
  poNo: string;
  modelCode: string;
  status: string;
  ordered: number;
  noted: number;
  received: number;
  shortfall: number;
  missing: string[];
  unexpected: string[];
}

/** 발주 대비 입고 대조(F10): 발주 목록, 발주하기, 고른 발주의 대조(명세·입고·빠진 것·명세 밖), 마감 */
export function PurchaseOrdersPage() {
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [modelCode, setModelCode] = useState('');
  const [quantity, setQuantity] = useState('10');
  const list = useBeforeIdList<PurchaseOrderView>('purchase-orders', '/purchase-orders');
  const models = useQuery({ queryKey: ['terminal-models'], queryFn: () => api<TerminalModelView[]>('/terminal-models'), staleTime: Infinity });
  const recon = useQuery({
    queryKey: ['purchase-order', selected, 'reconciliation'],
    queryFn: () => api<Reconciliation>(`/purchase-orders/${encodeURIComponent(selected!)}/reconciliation`),
    enabled: selected !== null,
  });
  const order = useMutation({
    mutationFn: () => api<PurchaseOrderView>('/purchase-orders', { method: 'POST', body: { modelCode, quantity: Number(quantity) } }),
    onSuccess: async (po) => {
      await client.invalidateQueries({ queryKey: ['purchase-orders'] });
      setSelected(po.poNo);
    },
  });
  const close = useMutation({
    mutationFn: (poNo: string) => api(`/purchase-orders/${encodeURIComponent(poNo)}/close`, { method: 'POST' }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['purchase-orders'] });
      await client.invalidateQueries({ queryKey: ['purchase-order'] });
    },
  });
  const qty = Number(quantity);

  return (
    <section>
      <h2>발주 입고 대조</h2>
      <div className="row">
        <select aria-label="발주 모델" value={modelCode} onChange={(e) => setModelCode(e.target.value)}>
          <option value="">모델 선택</option>
          {models.data?.map((m) => (
            <option key={m.code} value={m.code}>
              {m.code} {m.name}
            </option>
          ))}
        </select>
        <input aria-label="수량" type="number" min={1} max={5000} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        <WriteButton disabled={!modelCode || !Number.isInteger(qty) || qty < 1 || qty > 5000 || order.isPending} onClick={() => order.mutate()}>
          발주하기
        </WriteButton>
      </div>
      <ErrorBox error={list.error ?? order.error ?? close.error} />
      <table>
        <thead>
          <tr>
            <th scope="col">발주번호</th>
            <th scope="col">모델</th>
            <th scope="col">수량</th>
            <th scope="col">상태</th>
            <th scope="col">발주</th>
            <th scope="col">마감</th>
          </tr>
        </thead>
        <tbody>
          {itemsOf(list.data).map((p) => (
            <tr key={p.id} aria-selected={selected === p.poNo}>
              <td>
                <button type="button" onClick={() => setSelected(p.poNo)}>
                  {p.poNo}
                </button>
              </td>
              <td>{p.modelCode}</td>
              <td>{p.quantity}</td>
              <td>{p.status}</td>
              <td>
                {formatKst(p.createdAt)} · {p.orderedBy}
              </td>
              <td>{p.closedAt ? `${formatKst(p.closedAt)} · ${p.closedBy}` : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <MoreButton hasNextPage={list.hasNextPage} isFetchingNextPage={list.isFetchingNextPage} fetchNextPage={list.fetchNextPage} />
      {selected ? (
        <div className="panel" aria-label="입고 대조">
          <h3>발주 {selected} 대조</h3>
          <ErrorBox error={recon.error} />
          {recon.data ? (
            <>
              <dl className="info">
                <dt>발주 수량</dt>
                <dd>{recon.data.ordered}</dd>
                <dt>납품 명세</dt>
                <dd>
                  {recon.data.noted}
                  {recon.data.shortfall !== 0 ? <span className="bad"> (발주와 차이 {recon.data.shortfall})</span> : null}
                </dd>
                <dt>입고</dt>
                <dd>{recon.data.received}</dd>
                <dt>명세에 있는데 안 들어옴</dt>
                <dd>{recon.data.missing.length ? recon.data.missing.join(', ') : '없음'}</dd>
                <dt>명세 밖이라 거절</dt>
                <dd>{recon.data.unexpected.length ? recon.data.unexpected.join(', ') : '없음'}</dd>
              </dl>
              {recon.data.status !== 'CLOSED' ? (
                <WriteButton
                  className="danger"
                  disabled={close.isPending}
                  onClick={() => {
                    if (window.confirm(`발주 ${selected}을(를) 마감할까요? 마감하면 입고 스캔을 받지 않습니다.`)) close.mutate(selected);
                  }}
                >
                  마감
                </WriteButton>
              ) : (
                <p className="muted">마감된 발주입니다.</p>
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
