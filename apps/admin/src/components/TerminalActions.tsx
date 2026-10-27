import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { InspectionItemView, MerchantView, TerminalDetail } from '../api/types';
import { CARRIER_LABEL, label, TERMINAL_STATUS_LABEL } from '../lib/labels';
import { ErrorBox } from './ErrorBox';
import { WriteButton } from './WriteButton';

/**
 * 단말기 상세의 "할 수 있는 일". 무엇을 보여 줄지는 서버가 준 allowedTransitions·actions만 본다(전이 규칙을 화면에 두지 않는다, decisions/0040).
 * 모든 요청에 화면에서 본 version(expectedVersion)을 실어 보낸다 — 그사이 다른 변경이 있으면 409 VERSION_CONFLICT(decisions/0004).
 */
export function TerminalActions({ terminal, onReload }: { terminal: TerminalDetail; onReload: () => void }) {
  const client = useQueryClient();
  const path = `/terminals/${encodeURIComponent(terminal.serialNo)}`;
  const [pick, setSelected] = useState<string | null>(null);
  // 다시 불러온 상세에서 고른 전이가 없어졌거나 막혔으면 선택을 푼다
  const selected = terminal.allowedTransitions.some((t) => t.to === pick && t.blockedReason === null) ? pick : null;
  const [reason, setReason] = useState('');
  const [merchantCode, setMerchantCode] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [carrier, setCarrier] = useState('BUNGAE');

  const merchants = useQuery({
    queryKey: ['merchants'],
    queryFn: () => api<MerchantView[]>('/merchants'),
    enabled: terminal.actions.allocate,
    staleTime: Infinity,
  });

  const action = useMutation({
    mutationFn: ({ url, body }: { url: string; body: unknown }) => api(url, { method: 'POST', body }),
    onSuccess: async () => {
      setSelected(null);
      setReason('');
      setCancelReason('');
      await client.invalidateQueries({ queryKey: ['terminal', terminal.serialNo] });
      await client.invalidateQueries({ queryKey: ['terminals'] });
    },
  });
  const run = (url: string, body: Record<string, unknown>) => action.mutate({ url, body: { ...body, expectedVersion: terminal.version } });

  const nothing =
    terminal.allowedTransitions.length === 0 && !Object.values(terminal.actions).some(Boolean);

  return (
    <div className="panel">
      <h3>할 수 있는 일</h3>
      <ErrorBox
        error={action.error}
        onReload={() => {
          action.reset();
          onReload();
        }}
      />
      {nothing ? <p className="muted">지금 상태({label(TERMINAL_STATUS_LABEL, terminal.status)})에서 할 수 있는 변경이 없습니다.</p> : null}

      {terminal.allowedTransitions.length > 0 ? (
        <div>
          <div className="actions">
            {terminal.allowedTransitions.map((t) => (
              <button
                key={t.to}
                type="button"
                disabled={t.blockedReason !== null}
                title={t.blockedReason ?? undefined}
                aria-pressed={selected === t.to}
                onClick={() => setSelected(t.to)}
              >
                → {label(TERMINAL_STATUS_LABEL, t.to)}
              </button>
            ))}
          </div>
          {terminal.allowedTransitions
            .filter((t) => t.blockedReason)
            .map((t) => (
              <p key={t.to} className="muted">
                {label(TERMINAL_STATUS_LABEL, t.to)}: {t.blockedReason}
              </p>
            ))}
          {selected ? (
            <div className="row">
              <input aria-label="변경 사유" placeholder="사유(필수)" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
              <WriteButton
                className="primary"
                disabled={!reason.trim() || action.isPending}
                onClick={() => run(`${path}/transitions`, { to: selected, reason: reason.trim() })}
              >
                {label(TERMINAL_STATUS_LABEL, selected)}(으)로 바꾸기
              </WriteButton>
            </div>
          ) : null}
        </div>
      ) : null}

      {terminal.actions.allocate ? (
        <div className="row">
          <select aria-label="배정 가맹점" value={merchantCode} onChange={(e) => setMerchantCode(e.target.value)}>
            <option value="">가맹점 선택</option>
            {merchants.data?.map((m) => (
              <option key={m.code} value={m.code}>
                {m.name} ({m.code})
              </option>
            ))}
          </select>
          <WriteButton disabled={!merchantCode || action.isPending} onClick={() => run(`${path}/allocations`, { merchantCode })}>
            가맹점 배정
          </WriteButton>
        </div>
      ) : null}

      {terminal.actions.cancelAllocation ? (
        <div className="row">
          <input aria-label="배정 취소 사유" placeholder="배정 취소 사유" value={cancelReason} maxLength={200} onChange={(e) => setCancelReason(e.target.value)} />
          <WriteButton
            disabled={!cancelReason.trim() || action.isPending}
            onClick={() => run(`${path}/allocation-cancellations`, { reason: cancelReason.trim() })}
          >
            배정 취소
          </WriteButton>
        </div>
      ) : null}

      {terminal.actions.ship ? (
        <div className="row">
          <select aria-label="택배사" value={carrier} onChange={(e) => setCarrier(e.target.value)}>
            {Object.entries(CARRIER_LABEL).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
          <WriteButton disabled={action.isPending} onClick={() => run('/shipments', { serialNo: terminal.serialNo, carrier })}>
            출고(운송장 발급)
          </WriteButton>
        </div>
      ) : null}

      {terminal.actions.inspect ? <InspectForm terminal={terminal} onReload={onReload} /> : null}
    </div>
  );
}

/** 검수(F13): 모델 체크리스트 항목마다 합격/불합격. 하나라도 불합격이면 서버가 DEFECTIVE로 바꾼다 */
function InspectForm({ terminal, onReload }: { terminal: TerminalDetail; onReload: () => void }) {
  const client = useQueryClient();
  const items = useQuery({
    queryKey: ['inspection-items', terminal.modelCode],
    queryFn: () => api<InspectionItemView[]>('/inspection-items', { query: { modelCode: terminal.modelCode } }),
    staleTime: Infinity,
  });
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const inspect = useMutation({
    mutationFn: (results: { itemCode: string; passed: boolean }[]) =>
      api(`/terminals/${encodeURIComponent(terminal.serialNo)}/inspections`, { method: 'POST', body: { results } }),
    onSuccess: async () => {
      setFailed({});
      await client.invalidateQueries({ queryKey: ['terminal', terminal.serialNo] });
      await client.invalidateQueries({ queryKey: ['terminals'] }); // 상태가 DEFECTIVE 등으로 바뀔 수 있어 목록도
    },
  });
  if (items.error) return <ErrorBox error={items.error} />;
  if (!items.data) return null;
  return (
    <fieldset className="panel">
      <legend>검수 — 불합격 항목에 표시</legend>
      {items.data.map((item) => (
        <label key={item.code} className="row">
          <input
            type="checkbox"
            checked={failed[item.code] ?? false}
            onChange={(e) => setFailed({ ...failed, [item.code]: e.target.checked })}
          />
          {item.label} 불합격
        </label>
      ))}
      <ErrorBox
        error={inspect.error}
        onReload={() => {
          inspect.reset();
          onReload();
        }}
      />
      <WriteButton
        disabled={inspect.isPending}
        onClick={() => inspect.mutate(items.data.map((item) => ({ itemCode: item.code, passed: !failed[item.code] })))}
      >
        검수 결과 저장
      </WriteButton>
    </fieldset>
  );
}
