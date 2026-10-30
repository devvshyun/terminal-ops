import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PurchaseOrderReconciliation, PurchaseOrderView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { ErrorBox } from '../components/ErrorBox';
import { Open, Run, Step } from '../components/Step';
import { remember, useRecall } from '../lib/memo';
import { call } from '../lib/servers';

const POLL_MS = 5000;

/** 막 2 공장에서 창고로: 세움전자 납품 명세 → 현장 박스 스캔 → 입고 대조·마감. 열린(마감 전) 가장 최근 발주를 쓴다 */
export function Act2() {
  const orders = useQuery({ queryKey: keys.purchaseOrders, queryFn: () => api<{ items: PurchaseOrderView[] }>('/purchase-orders') });
  // 이 막에서 다루던 발주를 기억한다 — 마감해 열린 발주가 없어져도 그 대조를 그대로 보인다(리허설에서 찾음)
  const picked = useRecall('act2-po');
  const items = orders.data?.items ?? [];
  const po = items.find((p) => p.poNo === picked) ?? items.find((p) => p.status !== 'CLOSED') ?? null;
  const reconciliation = useQuery({
    queryKey: keys.reconciliation(po?.poNo ?? ''),
    queryFn: () => api<PurchaseOrderReconciliation>(`/purchase-orders/${po!.poNo}/reconciliation`),
    enabled: po !== null,
    // 마감한 발주는 더 바뀌지 않는다 — 다시 읽지 않는다
    refetchInterval: po?.status === 'CLOSED' ? false : POLL_MS,
  });
  const [serials, setSerials] = useState<string[] | null>(null);
  const r = reconciliation.data;
  return (
    <>
      <Step
        stepKey="2-note"
        n="2-1"
        title="공장 납품 명세"
        who="시연자 · 세움전자(가상 공장)"
        actions={
          po && po.status !== 'CLOSED' ? (
            <Run
              label="납품 명세 불러오기"
              stepKey="2-note"
              needsLogin={false}
              onRun={async () => {
                remember('act2-po', po.poNo);
                const note = await call<{ serials: string[] }>('partners', `/seum/v1/purchase-orders/${encodeURIComponent(po.poNo)}/delivery-note`);
                setSerials(note.serials);
                return `${note.serials.length}대`;
              }}
            />
          ) : (
            <Run
              label="새 발주(SN-100 10대)"
              stepKey="2-note"
              markStep={false}
              onRun={async () => {
                // 새 발주를 기억한다 — 마감한 발주에 머물지 않게(최종 검토). 2-1은 납품 명세를 불러와야 끝냄
                const created = await api<PurchaseOrderView>('/purchase-orders', { method: 'POST', body: { modelCode: 'SN-100', quantity: 10 } });
                remember('act2-po', created.poNo);
                return '발주했습니다';
              }}
            />
          )
        }
        result={
          <>
            <ErrorBox error={orders.error} />
            {po ? <p>발주 <span className="mono strong">{po.poNo}</span> · {po.modelCode} {po.quantity}대</p> : orders.data ? <p className="empty">열린 발주가 없습니다. 새 발주를 내세요.</p> : null}
            {serials ? (
              <>
                <textarea aria-label="납품 시리얼" className="mono" readOnly rows={Math.min(8, serials.length)} value={serials.join('\n')} />
                <button type="button" onClick={() => void navigator.clipboard?.writeText(serials.join('\n'))}>시리얼 복사</button>
              </>
            ) : null}
          </>
        }
      >
        <p>공장이 실제로 보낸 시리얼 목록입니다. 시연 데이터의 발주는 세움전자가 2대 덜 보내게 해 두었습니다. 현장 작업자는 이 시리얼을 바코드 대신 붙여 넣습니다.</p>
      </Step>
      <Step stepKey="2-scan" n="2-2" title="현장 박스 스캔" who="현장 작업자(field) · 현장 화면" actions={<Open app="field" path="/scan" label="현장 박스 스캔 열기" />}
        result={r ? <p className="big">입고 {r.received} / 명세 {r.noted}</p> : <p className="muted">발주가 생기면 입고 수를 5초마다 다시 읽습니다.</p>}
      >
        <p>현장 화면에 <code>field</code>로 로그인 → "발주분 입고" → 발주 고르기 → 시리얼을 붙여 넣고 보내기. 같은 상자를 두 번 보내도 한 번만 처리됩니다(멱등 키).</p>
      </Step>
      <Step
        stepKey="2-close"
        n="2-3"
        title="입고 대조와 마감"
        who="운영자"
        actions={po && po.status !== 'CLOSED' ? <Run label="발주 마감" stepKey="2-close" onRun={async () => { remember('act2-po', po.poNo); await api(`/purchase-orders/${po.poNo}/close`, { method: 'POST' }); return '마감했습니다'; }} /> : null}
        result={
          <>
            <ErrorBox error={reconciliation.error} />
            {po?.status === 'CLOSED' ? <p className="big">{po.poNo} · 마감됨</p> : null}
            {r ? <p>발주 {r.ordered} · 명세 {r.noted} · 입고 {r.received} · 차이 {r.shortfall}</p> : null}
            {r && r.missing.length > 0 ? <small className="muted">명세에 있는데 안 들어옴: {r.missing.join(', ')}</small> : null}
          </>
        }
      >
        <p>발주 수량·공장 명세·실제 입고를 맞춰 봅니다. 마감하면 그 발주로는 더 입고 스캔을 받지 않습니다.</p>
      </Step>
    </>
  );
}
