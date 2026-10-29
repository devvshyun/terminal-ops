import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreatePartnerRequest, PartnerView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { ErrorBox } from '../components/ErrorBox';
import { agoText } from '../lib/format';
import { PARTNER_CODE } from '../lib/labels';

/**
 * 외부 업체(보강 7, decisions/0081): 목록(코드·이름·살아 있는 키/전체·마지막 사용)과 등록 폼.
 * 등록하면 그 업체 화면으로 간다 — 다음 할 일이 키 발급이라서.
 */
export function PartnersPage() {
  const partners = useQuery({ queryKey: keys.partners, queryFn: () => api<PartnerView[]>('/admin/partners') });
  const now = new Date();
  return (
    <>
      <h1>외부 업체</h1>
      <p className="muted lead">우리 API를 부르는 업체입니다. 업체마다 키를 발급하고, 키마다 열 범위를 고릅니다.</p>
      <div className="split">
        <section className="panel">
          <ErrorBox error={partners.error} />
          {partners.data && partners.data.length === 0 ? <p className="empty">아직 등록한 업체가 없습니다. 오른쪽에서 등록하세요.</p> : null}
          {partners.data && partners.data.length > 0 ? (
            <table aria-label="외부 업체 목록">
              <thead>
                <tr>
                  <th scope="col">코드</th>
                  <th scope="col">이름</th>
                  <th scope="col" className="num">
                    키(사용 중 / 전체)
                  </th>
                  <th scope="col">마지막 사용</th>
                </tr>
              </thead>
              <tbody>
                {partners.data.map((p) => (
                  <tr key={p.id}>
                    <td className="mono strong">{p.code}</td>
                    <td>
                      <Link to={`/partners/${p.id}`}>{p.name}</Link>
                      {p.memo ? <small className="muted block">{p.memo}</small> : null}
                    </td>
                    <td className="num">
                      {p.activeKeys} / {p.totalKeys}
                    </td>
                    <td className="ago">{p.lastUsedAt ? agoText(p.lastUsedAt, now) : <span className="muted">쓴 적 없음</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
        <CreatePartnerForm />
      </div>
    </>
  );
}

function CreatePartnerForm() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [memo, setMemo] = useState('');
  const create = useMutation({
    mutationFn: (body: CreatePartnerRequest) => api<PartnerView>('/admin/partners', { method: 'POST', body }),
    onSuccess: async (p) => {
      await client.invalidateQueries({ queryKey: keys.partners });
      navigate(`/partners/${p.id}`);
    },
  });
  const upper = code.trim().toUpperCase();
  const codeOk = PARTNER_CODE.test(upper);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({ code: upper, name: name.trim(), memo: memo.trim() || null });
  };
  return (
    <form className="panel form" onSubmit={submit} aria-label="업체 등록">
      <h2>업체 등록</h2>
      <label>
        업체 코드
        <input aria-label="업체 코드" className="mono" value={code} maxLength={20} onChange={(e) => setCode(e.target.value)} placeholder="HANOL-POS" />
        <small className={code && !codeOk ? 'hint bad' : 'hint'}>대문자·숫자·- 2~20자</small>
      </label>
      <label>
        업체 이름
        <input aria-label="업체 이름" value={name} maxLength={50} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        메모(선택)
        <input aria-label="메모" value={memo} maxLength={200} onChange={(e) => setMemo(e.target.value)} placeholder="연동 담당·목적" />
      </label>
      <button type="submit" className="primary" disabled={!codeOk || !name.trim() || create.isPending}>
        업체 등록
      </button>
      <ErrorBox error={create.error} />
    </form>
  );
}
