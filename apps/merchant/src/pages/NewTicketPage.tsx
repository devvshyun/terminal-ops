import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MerchantTicketView, OpenTicketRequest } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { useMyTerminals } from '../api/queries';
import { keys } from '../api/query-keys';
import { ErrorBox } from '../components/ErrorBox';
import { SYMPTOMS } from '../lib/labels';
import { composeSymptom, memoMax } from '../lib/symptom';

/**
 * 고장 접수: 사용 중인 단말기 고르기(단말기 상세에서 오면 ?serialNo=로 골라 둔다) → 증상 고르기 → 메모(선택) → 접수.
 * 접수되면 그 접수 화면으로. 쓰기 뒤에는 'me' 묶음 전체를 무효화한다(단말기·A/S 목록이 함께 바뀐다, query-keys.ts).
 */
export function NewTicketPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const terminals = useMyTerminals();
  const [serialNo, setSerialNo] = useState(params.get('serialNo') ?? '');
  const [choice, setChoice] = useState('');
  const [memo, setMemo] = useState('');
  const open = useMutation({
    mutationFn: (body: OpenTicketRequest) => api<MerchantTicketView>('/me/service-tickets', { method: 'POST', body }),
    onSuccess: async (t) => {
      await client.invalidateQueries({ queryKey: keys.all });
      navigate(`/service-tickets/${t.id}`, { replace: true });
    },
  });

  if (terminals.error) return <ErrorBox error={terminals.error} />;
  if (!terminals.data) return <p>불러오는 중…</p>;
  const usable = terminals.data.items.filter((t) => t.status === 'IN_SERVICE');
  // 고른 시리얼이 사용 중 목록에 없으면(주소를 손으로 고침, 그사이 상태가 바뀜) 고르지 않은 것으로 본다
  const chosen = usable.find((t) => t.serialNo === serialNo)?.serialNo ?? '';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    open.mutate({ serialNo: chosen, symptom: composeSymptom(choice, memo) } satisfies OpenTicketRequest);
  };

  return (
    <form onSubmit={submit}>
      <h1>고장 접수</h1>
      {usable.length === 0 ? <p className="muted">사용 중인 단말기가 없어 접수할 수 없습니다.</p> : null}
      <label>
        단말기
        <select aria-label="단말기" value={chosen} onChange={(e) => setSerialNo(e.target.value)}>
          <option value="">고르세요</option>
          {usable.map((t) => (
            <option key={t.serialNo} value={t.serialNo}>
              {t.modelName} {t.serialNo}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="card">
        <legend>증상</legend>
        {SYMPTOMS.map((s) => (
          <label key={s} className="choice">
            <input type="radio" name="symptom" value={s} checked={choice === s} onChange={() => setChoice(s)} />
            {s}
          </label>
        ))}
      </fieldset>
      <label>
        메모(선택)
        <textarea aria-label="메모" rows={3} value={memo} maxLength={choice ? memoMax(choice) : undefined} onChange={(e) => setMemo(e.target.value)} placeholder="언제부터, 어떤 화면이 나오는지" />
      </label>
      <button type="submit" className="primary" disabled={!chosen || !choice || open.isPending}>
        접수하기
      </button>
      <ErrorBox error={open.error} />
    </form>
  );
}
