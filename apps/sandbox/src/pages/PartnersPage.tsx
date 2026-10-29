import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorBox } from '../components/ErrorBox';
import { codeClass, faultsOn, PARTNERS, toInput, toServerValue, type PartnerDef } from '../lib/knobs';
import { call } from '../lib/servers';
import { kstTime } from '../lib/time';
import type { PartnersConfig, RequestsPage, ToktokMessages } from '../lib/types';

/** 최근 요청·톡톡 메시지를 다시 읽는 간격 */
const POLL_MS = 5000;
const keys = { config: ['partners', 'config'] as const, requests: (partner: string) => ['partners', 'requests', partner] as const, requestsAll: ['partners', 'requests'] as const, toktok: ['partners', 'toktok'] as const };
const NAME: Record<string, string> = Object.fromEntries(PARTNERS.map((p) => [p.key, p.name]));

/**
 * 가상 업체(보강 8): 업체 다섯의 장애 손잡이(지금 값은 서버에서 읽는다)와 업체가 받은 최근 요청·톡톡 메시지.
 * 적용하면 그 업체의 바뀐 손잡이만 보낸다(`POST /__admin/config`는 부분 병합 — 다른 업체 값을 덮지 않는다).
 */
export function PartnersPage() {
  const client = useQueryClient();
  const config = useQuery({ queryKey: keys.config, queryFn: () => call<PartnersConfig>('partners', '/__admin/config') });
  const reset = useMutation({
    mutationFn: () => call<PartnersConfig>('partners', '/__admin/reset', { method: 'POST' }),
    onSuccess: (c) => {
      client.setQueryData(keys.config, c);
      void client.invalidateQueries({ queryKey: keys.requestsAll });
      void client.invalidateQueries({ queryKey: keys.toktok });
    },
  });
  const onReset = () => {
    if (!window.confirm('업체 다섯의 설정을 기본값으로 되돌리고, 받은 데이터(운송장·송장·발주·VAN 등록·톡톡 메시지·요청 기록)도 지웁니다. 진행할까요?')) return;
    reset.mutate();
  };
  return (
    <>
      <div className="head-row">
        <div>
          <h1>가상 업체</h1>
          <p className="muted lead">우리 시스템이 부르는 바깥 업체(모두 가상)입니다. 확률·지연을 켜면 다음 요청부터 그렇게 답합니다.</p>
        </div>
        <button type="button" className="danger" disabled={reset.isPending || !config.data} onClick={onReset}>
          모두 기본값으로
        </button>
      </div>
      <ErrorBox error={config.error ?? reset.error} />
      {config.data ? (
        <div className="cards">
          {PARTNERS.map((def) => (
            // 서버 값이 바뀌면(적용·기본값으로) 카드를 새로 그려 입력도 그 값으로 시작한다
            <PartnerCard key={`${def.key}:${JSON.stringify(config.data[def.key])}`} def={def} values={config.data[def.key]} />
          ))}
        </div>
      ) : null}
      <DeliveryNote />
      <Requests />
      <Toktok />
    </>
  );
}

function PartnerCard({ def, values }: { def: PartnerDef; values: Record<string, number | boolean> }) {
  const client = useQueryClient();
  const [inputs, setInputs] = useState<Record<string, string | boolean>>(() => Object.fromEntries(def.knobs.map((k) => [k.key, toInput(k, values[k.key])])));
  const apply = useMutation({
    mutationFn: (patch: Record<string, number | boolean>) => call<PartnersConfig>('partners', '/__admin/config', { method: 'POST', body: { [def.key]: patch } }),
    onSuccess: (c) => client.setQueryData(keys.config, c),
  });
  const parsed = def.knobs.map((k) => ({ knob: k, value: toServerValue(k, inputs[k.key]) }));
  const invalid = parsed.some((p) => p.value === null);
  const patch = Object.fromEntries(parsed.filter((p) => p.value !== null && p.value !== values[p.knob.key]).map((p) => [p.knob.key, p.value as number | boolean]));
  const faults = faultsOn(def, values);
  return (
    <section className={faults.length ? 'card fault' : 'card'} aria-label={def.name}>
      <header>
        <h2>{def.name}</h2>
        <span className={faults.length ? 'state bad' : 'state ok'}>{faults.length ? `장애: ${faults.join(' · ')}` : '정상'}</span>
      </header>
      <p className="muted small">{def.role}</p>
      <form
        className="knobs"
        onSubmit={(e) => {
          e.preventDefault();
          apply.mutate(patch);
        }}
      >
        {def.knobs.map((k) =>
          k.kind === 'bool' ? (
            <label key={k.key} className="check">
              <input type="checkbox" checked={inputs[k.key] === true} onChange={(e) => setInputs({ ...inputs, [k.key]: e.target.checked })} />
              {k.label}
            </label>
          ) : (
            <label key={k.key}>
              <span>
                {k.label}
                <small>{k.kind === 'rate' ? '%' : k.kind === 'ms' ? 'ms' : ''}</small>
              </span>
              <input
                aria-label={`${k.label}${k.kind === 'rate' ? '(%)' : k.kind === 'ms' ? '(ms)' : ''}`}
                type="number"
                min={0}
                max={k.kind === 'rate' ? 100 : k.max}
                step={k.kind === 'rate' ? 'any' : 1}
                value={inputs[k.key] as string}
                className={toServerValue(k, inputs[k.key]) === null ? 'bad' : undefined}
                onChange={(e) => setInputs({ ...inputs, [k.key]: e.target.value })}
              />
            </label>
          ),
        )}
        <button type="submit" className="primary" disabled={invalid || Object.keys(patch).length === 0 || apply.isPending}>
          적용
        </button>
      </form>
      <ErrorBox error={apply.error} />
    </section>
  );
}

interface DeliveryNoteView {
  poNo: string;
  modelCode: string;
  quantity: number;
  serials: string[];
}

/**
 * 세움전자 납품 명세(보강 9 리허설): 공장이 실제로 보낸 시리얼 목록. 현장 작업자가 박스 스캔에 붙여 넣는다 — 시연에서 바코드를 대신한다.
 * 가상 업체 서버의 공개 API(`/seum/v1/purchase-orders/:poNo/delivery-note`)를 그대로 부른다(api가 입고 대조에 쓰는 것과 같다).
 */
function DeliveryNote() {
  const [poNo, setPoNo] = useState('');
  const [copied, setCopied] = useState(false);
  const note = useMutation({
    mutationFn: (no: string) => call<DeliveryNoteView>('partners', `/seum/v1/purchase-orders/${encodeURIComponent(no)}/delivery-note`),
    onMutate: () => setCopied(false),
  });
  const text = note.data?.serials.join('\n') ?? '';
  return (
    <section className="section" aria-label="세움전자 납품 명세">
      <h2>
        세움전자 납품 명세 <small className="muted">발주번호는 어드민 "발주 입고 대조"에 있다 · 현장 박스 스캔에 붙여 넣는다</small>
      </h2>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          note.mutate(poNo.trim());
        }}
      >
        <input aria-label="발주번호" className="mono" placeholder="SE…" value={poNo} onChange={(e) => setPoNo(e.target.value)} />
        <button type="submit" disabled={!poNo.trim() || note.isPending}>
          보기
        </button>
      </form>
      <ErrorBox error={note.error} />
      {note.data ? (
        <div className="panel note">
          <p>
            <strong>
              발주 {note.data.quantity}대 · 명세 {note.data.serials.length}대
            </strong>{' '}
            <span className="muted">{note.data.modelCode}</span>
          </p>
          <textarea aria-label="납품 시리얼" className="mono" readOnly rows={Math.min(10, note.data.serials.length)} value={text} />
          <div className="row">
            <button type="button" onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}>
              시리얼 복사
            </button>
            {copied ? <span className="ok-text">복사했습니다</span> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Requests() {
  const [partner, setPartner] = useState('');
  // 업체 거르기는 서버에서(?partner=) — 최근 100개를 자른 뒤 거르면 조용한 업체가 안 보인다(최종 검토)
  const page = useQuery({
    queryKey: keys.requests(partner),
    queryFn: () => call<RequestsPage>('partners', `/__admin/requests?limit=100${partner ? `&partner=${partner}` : ''}`),
    refetchInterval: POLL_MS,
  });
  const items = page.data?.items ?? [];
  return (
    <section className="section" aria-label="최근 요청">
      <div className="head-row">
        <h2>
          최근 요청 <small className="muted">{page.data ? `받은 요청 ${page.data.total}개 중 최근 100개 · 5초마다` : ''}</small>
        </h2>
        <label className="inline">
          업체
          <select aria-label="업체" value={partner} onChange={(e) => setPartner(e.target.value)}>
            <option value="">전체</option>
            {PARTNERS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorBox error={page.error} />
      {page.data && items.length === 0 ? <p className="empty">{partner ? `${NAME[partner]}가 받은 요청이 아직 없습니다.` : '아직 받은 요청이 없습니다.'}</p> : null}
      {items.length > 0 ? (
        <table aria-label="최근 요청">
          <thead>
            <tr>
              <th scope="col">시각</th>
              <th scope="col">업체</th>
              <th scope="col">요청</th>
              <th scope="col">상태</th>
              <th scope="col" className="num">
                걸린 시간
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td className="time">{kstTime(r.at)}</td>
                <td>{NAME[r.partner] ?? r.partner}</td>
                <td className="mono">
                  <span className="method">{r.method}</span> {r.path}
                </td>
                <td>
                  {/* 0 = 응답을 다 보내기 전에 끊김(보낸 쪽이 먼저 끊음) */}
                  <span className={`code ${r.status === 0 ? 'code-5xx' : codeClass(r.status)}`}>{r.status === 0 ? '끊김' : r.status}</span>
                </td>
                <td className="num">{r.ms}ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

function Toktok() {
  const box = useQuery({ queryKey: keys.toktok, queryFn: () => call<ToktokMessages>('partners', '/__admin/toktok/messages'), refetchInterval: POLL_MS });
  const recent = [...(box.data?.messages ?? [])].reverse().slice(0, 20);
  return (
    <section className="section" aria-label="톡톡 메시지">
      <h2>
        톡톡 메시지 <small className="muted">{box.data ? `받은 메시지 ${box.data.total}개 중 최근 20개` : ''}</small>
      </h2>
      <ErrorBox error={box.error} />
      {box.data && recent.length === 0 ? <p className="empty">아직 받은 메시지가 없습니다.</p> : null}
      {recent.length > 0 ? (
        <ul className="messages">
          {recent.map((m) => (
            <li key={`${m.idempotencyKey}-${m.receivedAt}`}>
              <span className="time">{kstTime(m.receivedAt)}</span>
              <span className="mono tag">{m.channel}</span>
              <span className="text">{m.text}</span>
              {m.attachments.length > 0 ? <small className="muted">첨부 {m.attachments.map((a) => a.fileName).join(', ')}</small> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
