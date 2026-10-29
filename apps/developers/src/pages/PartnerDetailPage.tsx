import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BeforeIdPage, CreatedPartnerKeyView, CreatePartnerKeyRequest, PartnerCallView, PartnerKeyView, PartnerScope, PartnerView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { CallsTable } from '../components/CallsTable';
import { ErrorBox } from '../components/ErrorBox';
import { agoText, formatKst } from '../lib/format';
import { endOfKstDay, KEY_STATE_LABEL, keyState, PARTNER_SCOPES, SCOPE_LABEL, scopesText } from '../lib/labels';

/** 업체 화면 아래 최근 호출 수 */
const RECENT_CALLS = 20;

/**
 * 업체 한 곳(보강 7): 키 목록·발급·폐기, 이 업체의 최근 호출.
 * 업체 한 곳을 읽는 API는 따로 없다 — 업체 목록(GET /admin/partners, 수십 곳)에서 찾는다.
 * 발급한 키의 원문은 이 화면의 상태에만 잠깐 있다(쿼리 캐시에 넣지 않는다) — "보관했습니다"를 누르거나 화면을 떠나면 사라지고 다시 볼 수 없다(decisions/0054).
 */
export function PartnerDetailPage() {
  const id = Number(useParams().id);
  const partners = useQuery({ queryKey: keys.partners, queryFn: () => api<PartnerView[]>('/admin/partners') });
  const partner = partners.data?.find((p) => p.id === id);
  if (partners.error) return <ErrorBox error={partners.error} />;
  if (!partners.data) return <p>불러오는 중…</p>;
  if (!partner) {
    return (
      <>
        <p>없는 업체입니다.</p>
        <Link to="/">← 업체 목록</Link>
      </>
    );
  }
  return (
    <>
      <Link to="/" className="back">
        ← 업체 목록
      </Link>
      <header className="partner-head">
        <h1>{partner.name}</h1>
        <span className="mono tag">{partner.code}</span>
      </header>
      {partner.memo ? <p className="muted lead">{partner.memo}</p> : null}
      <Keys partnerId={partner.id} />
      <RecentCalls partnerId={partner.id} />
    </>
  );
}

function Keys({ partnerId }: { partnerId: number }) {
  const client = useQueryClient();
  const list = useQuery({ queryKey: keys.keys(partnerId), queryFn: () => api<PartnerKeyView[]>('/admin/partner-keys', { query: { partnerId } }) });
  const [created, setCreated] = useState<CreatedPartnerKeyView | null>(null);
  const changed = () => Promise.all([client.invalidateQueries({ queryKey: keys.keysAll }), client.invalidateQueries({ queryKey: keys.partners })]);
  const revoke = useMutation({
    mutationFn: (k: PartnerKeyView) => api<PartnerKeyView>(`/admin/partner-keys/${k.id}/revoke`, { method: 'POST' }),
    onSuccess: changed,
  });
  const onRevoke = (k: PartnerKeyView) => {
    if (!window.confirm(`${k.prefix}(${k.name}) 키를 폐기할까요? 바로 401이 되고 되돌릴 수 없습니다.`)) return;
    revoke.mutate(k);
  };
  const now = new Date();
  return (
    <section className="section">
      <h2>키</h2>
      <div className="split">
        <div className="panel">
          <ErrorBox error={list.error ?? revoke.error} />
          {created ? <NewKey created={created} onDone={() => setCreated(null)} /> : null}
          {list.data && list.data.length === 0 ? <p className="empty">아직 발급한 키가 없습니다.</p> : null}
          {list.data && list.data.length > 0 ? (
            <table aria-label="키 목록">
              <thead>
                <tr>
                  <th scope="col">접두사</th>
                  <th scope="col">이름표</th>
                  <th scope="col">범위</th>
                  <th scope="col">상태</th>
                  <th scope="col">마지막 사용</th>
                  <th scope="col">
                    <span className="sr-only">작업</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((k) => {
                  const state = keyState(k, now);
                  return (
                    <tr key={k.id} className={state === 'active' ? undefined : 'dim'}>
                      <td className="mono strong">{k.prefix}</td>
                      <td>{k.name}</td>
                      <td>{scopesText(k.scopes)}</td>
                      <td>
                        <span className={`state state-${state}`}>{KEY_STATE_LABEL[state]}</span>
                        {state === 'active' && k.expiresAt ? <small className="muted block">{formatKst(k.expiresAt)}까지</small> : null}
                      </td>
                      <td className="ago">{k.lastUsedAt ? agoText(k.lastUsedAt, now) : <span className="muted">쓴 적 없음</span>}</td>
                      <td>
                        {state === 'active' ? (
                          <button type="button" className="danger" disabled={revoke.isPending} onClick={() => onRevoke(k)}>
                            폐기
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}
        </div>
        <IssueKeyForm partnerId={partnerId} onCreated={async (k) => { setCreated(k); await changed(); }} />
      </div>
    </section>
  );
}

/** 방금 발급한 키 원문 — 한 번만 */
function NewKey({ created, onDone }: { created: CreatedPartnerKeyView; onDone: () => void }) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const copy = () => {
    navigator.clipboard.writeText(created.key).then(
      () => setCopied('yes'),
      () => setCopied('failed'),
    );
  };
  return (
    <section className="new-key" aria-label="새 키">
      <strong>{created.name} 키를 발급했습니다.</strong>
      <p>이 원문은 지금 한 번만 보입니다. 닫으면 다시 볼 수 없습니다 — 업체에 안전한 길로 전하세요.</p>
      <code className="raw-key">{created.key}</code>
      <div className="row">
        <button type="button" onClick={copy}>
          복사
        </button>
        {copied === 'yes' ? <span className="ok-text">복사했습니다</span> : null}
        {copied === 'failed' ? <span className="bad-text">복사하지 못했습니다. 직접 골라 복사하세요.</span> : null}
        <button type="button" className="primary push" onClick={onDone}>
          보관했습니다
        </button>
      </div>
    </section>
  );
}

/** 발급 폼의 처음 범위 — 가장 좁은 것 하나. 발급할 때마다 여기로 돌아간다(앞 키의 넓은 범위를 실수로 물려받지 않게) */
const DEFAULT_SCOPES: PartnerScope[] = ['terminal-status:read'];

function IssueKeyForm({ partnerId, onCreated }: { partnerId: number; onCreated: (k: CreatedPartnerKeyView) => Promise<void> }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<PartnerScope[]>(DEFAULT_SCOPES);
  const [expires, setExpires] = useState('');
  const issue = useMutation({
    mutationFn: (body: CreatePartnerKeyRequest) => api<CreatedPartnerKeyView>('/admin/partner-keys', { method: 'POST', body }),
    onSuccess: async (k) => {
      setName('');
      setScopes(DEFAULT_SCOPES);
      setExpires('');
      await onCreated(k);
    },
  });
  const toggle = (s: PartnerScope) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : PARTNER_SCOPES.filter((x) => x === s || cur.includes(x))));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    issue.mutate({ partnerId, name: name.trim(), scopes, expiresAt: endOfKstDay(expires) });
  };
  return (
    <form className="panel form" onSubmit={submit} aria-label="키 발급">
      <h3>키 발급</h3>
      <label>
        키 이름표
        <input aria-label="키 이름표" value={name} maxLength={50} placeholder="운영 서버" onChange={(e) => setName(e.target.value)} />
      </label>
      <fieldset>
        <legend>범위</legend>
        {PARTNER_SCOPES.map((s) => (
          <label key={s} className="check">
            <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} />
            <span>
              {SCOPE_LABEL[s]}
              <code className="block">{s}</code>
            </span>
          </label>
        ))}
      </fieldset>
      <label>
        만료일(선택)
        <input aria-label="만료일(선택)" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
        <small className="hint">고르면 그날 23:59:59(KST)까지. 비우면 폐기할 때까지</small>
      </label>
      <button type="submit" className="primary" disabled={!name.trim() || scopes.length === 0 || issue.isPending}>
        키 발급
      </button>
      <ErrorBox error={issue.error} />
    </form>
  );
}

function RecentCalls({ partnerId }: { partnerId: number }) {
  const filter = { partnerId, limit: RECENT_CALLS };
  const calls = useQuery({ queryKey: keys.calls(filter), queryFn: () => api<BeforeIdPage<PartnerCallView>>('/admin/partner-calls', { query: filter }) });
  return (
    <section className="section">
      <h2>
        최근 호출 <small className="muted">최근 {RECENT_CALLS}개 · <Link to={`/calls?partnerId=${partnerId}`}>호출 로그에서 더 보기</Link></small>
      </h2>
      <ErrorBox error={calls.error} />
      {calls.data && calls.data.items.length === 0 ? <p className="empty">아직 이 업체의 호출이 없습니다.</p> : null}
      {calls.data && calls.data.items.length > 0 ? <CallsTable label="최근 호출" calls={calls.data.items} showPartner={false} /> : null}
    </section>
  );
}
