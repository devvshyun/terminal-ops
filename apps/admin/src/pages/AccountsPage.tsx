import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../api/client';
import { keys } from '../api/query-keys';
import type { AccountView, CreateAccountRequest, MerchantView, Role, UpdateAccountRequest } from '@terminal-ops/contracts';
import { ErrorBox } from '../components/ErrorBox';
import { formatKst } from '../lib/format';
import { ROLE_LABEL } from '../lib/labels';
import { useMe } from '../session';

/** 서버 규칙과 같은 아이디 형식(api auth/dto/login.dto.ts LOGIN_ID_INPUT — 대문자는 서버가 소문자로 저장) */
export const LOGIN_ID_PATTERN = /^[A-Za-z0-9._-]{3,50}$/;
const codePoints = (text: string) => [...text].length; // 서버(class-validator Length)도 글자(코드 포인트) 수로 센다
const ROLES = Object.keys(ROLE_LABEL) as Role[];

function MerchantSelect({ label, value, onChange, merchants }: { label: string; value: string; onChange: (v: string) => void; merchants: MerchantView[] | undefined }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">가맹점 선택</option>
      {merchants?.map((m) => (
        <option key={m.code} value={m.code}>
          {m.name} ({m.code})
        </option>
      ))}
    </select>
  );
}

/** 새 계정. 역할이 가맹점주면 가맹점이 꼭 있어야 한다(없으면 서버 400 MERCHANT_REQUIRED) */
function CreateAccountForm({ merchants }: { merchants: MerchantView[] | undefined }) {
  const client = useQueryClient();
  const [loginId, setLoginId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('OPERATOR');
  const [merchantCode, setMerchantCode] = useState('');
  const problems = [
    loginId && !LOGIN_ID_PATTERN.test(loginId) ? '아이디는 영문·숫자·`.`·`-`·`_` 3~50자입니다.' : null,
    displayName.trim() && codePoints(displayName.trim()) > 50 ? '표시 이름은 1~50자입니다.' : null,
    password && (codePoints(password) < 10 || codePoints(password) > 200) ? '비밀번호는 10~200자입니다.' : null,
    role === 'MERCHANT' && !merchantCode ? '가맹점주 계정은 가맹점을 골라야 합니다.' : null,
  ].filter((p): p is string => p !== null);
  const ready = LOGIN_ID_PATTERN.test(loginId) && displayName.trim() !== '' && codePoints(password) >= 10 && problems.length === 0;
  const [created, setCreated] = useState<{ loginId: string; role: Role } | null>(null);
  const create = useMutation({
    mutationFn: (body: CreateAccountRequest) => api<AccountView>('/admin/accounts', { method: 'POST', body }),
    gcTime: 0, // 끝난 요청(비밀번호가 든 변수)을 캐시에 남기지 않는다
    onSuccess: async (account) => {
      // 만든 계정 안내만 남기고, 비밀번호가 든 요청 변수는 mutation 상태에서 비운다
      setCreated({ loginId: account.loginId, role: account.role });
      create.reset();
      setLoginId('');
      setDisplayName('');
      setPassword('');
      await client.invalidateQueries({ queryKey: keys.accounts.all });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setCreated(null);
    create.mutate({ loginId, displayName: displayName.trim(), password, role, merchantCode: role === 'MERCHANT' ? merchantCode : null } satisfies CreateAccountRequest);
  };
  return (
    <form className="panel" aria-label="계정 만들기" onSubmit={submit}>
      <h3>계정 만들기</h3>
      <div className="row">
        <input aria-label="새 아이디" placeholder="아이디" autoComplete="off" value={loginId} onChange={(e) => setLoginId(e.target.value.trim())} />
        <input aria-label="표시 이름" placeholder="표시 이름" maxLength={50} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <input aria-label="처음 비밀번호" placeholder="처음 비밀번호(10자 이상)" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <select aria-label="새 역할" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        {role === 'MERCHANT' ? <MerchantSelect label="새 가맹점" value={merchantCode} onChange={setMerchantCode} merchants={merchants} /> : null}
        <button type="submit" className="primary" disabled={!ready || create.isPending}>
          만들기
        </button>
      </div>
      {problems.map((p) => (
        <p key={p} className="field-error">
          {p}
        </p>
      ))}
      {create.error instanceof ApiError && create.error.code === 'DUPLICATE' ? (
        <div className="error" role="alert">
          <strong>이미 있는 아이디입니다(대소문자 구분 없음).</strong>
          <div className="error-detail">
            {create.error.message}
            <code> DUPLICATE</code>
          </div>
        </div>
      ) : (
        <ErrorBox error={create.error} />
      )}
      {created ? (
        <p className="ok" role="status">
          {created.loginId} 만듦 · {ROLE_LABEL[created.role]}
        </p>
      ) : null}
    </form>
  );
}

/**
 * 계정 한 줄: 역할(가맹점주면 가맹점) 바꾸기, 사용 중지·다시 사용. 바꾸면 그 계정의 세션이 모두 끊긴다(api decisions/0050) —
 * 자기 계정이면 이 화면도 곧 로그인으로 돌아간다(확인을 받는다). 마지막 활성 ADMIN을 내리거나 중지하면 409 LAST_ADMIN.
 */
function AccountRow({ account, me, merchants }: { account: AccountView; me: string | undefined; merchants: MerchantView[] | undefined }) {
  const client = useQueryClient();
  const [role, setRole] = useState<Role>(account.role);
  const [merchantCode, setMerchantCode] = useState(account.merchantCode ?? '');
  const isMe = account.loginId === me;
  const update = useMutation({
    mutationFn: (body: UpdateAccountRequest) => api<AccountView>(`/admin/accounts/${account.id}`, { method: 'PATCH', body }),
    // 실패(409 LAST_ADMIN 등)도 화면이 낡았을 수 있어 다시 읽는다. 다시 읽은 값으로 고르던 칸도 되돌린다
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: keys.accounts.all });
    },
    onError: () => {
      setRole(account.role);
      setMerchantCode(account.merchantCode ?? '');
    },
  });
  const changed = role !== account.role || (role === 'MERCHANT' && merchantCode !== (account.merchantCode ?? ''));
  const selfWarning = isMe ? '\n내 계정입니다 — 저장하면 지금 세션이 끊겨 다시 로그인해야 합니다.' : '';
  const saveRole = () => {
    if (!window.confirm(`${account.loginId}의 역할을 ${ROLE_LABEL[role]}(으)로 바꿀까요? 그 계정의 로그인이 모두 끊깁니다.${selfWarning}`)) return;
    update.mutate({ role, merchantCode: role === 'MERCHANT' ? merchantCode : null } satisfies UpdateAccountRequest);
  };
  const toggleDisabled = () => {
    if (!account.disabled && !window.confirm(`${account.loginId}을(를) 사용 중지할까요? 그 계정의 로그인이 모두 끊기고 다시 로그인할 수 없습니다.${selfWarning}`)) return;
    update.mutate({ disabled: !account.disabled } satisfies UpdateAccountRequest);
  };
  return (
    <tr aria-label={`계정 ${account.loginId}`}>
      <td>
        {account.loginId}
        {isMe ? <span className="badge">나</span> : null}
      </td>
      <td>{account.displayName}</td>
      <td>
        <div className="row">
          <select aria-label="역할" value={role} disabled={update.isPending} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
          {role === 'MERCHANT' ? <MerchantSelect label="가맹점" value={merchantCode} onChange={setMerchantCode} merchants={merchants} /> : null}
          {changed ? (
            <button type="button" disabled={update.isPending || (role === 'MERCHANT' && !merchantCode)} onClick={saveRole}>
              역할 저장
            </button>
          ) : null}
        </div>
        <ErrorBox error={update.error} />
      </td>
      <td className={account.disabled ? 'bad' : undefined}>{account.disabled ? '사용 중지' : '사용 중'}</td>
      <td>{formatKst(account.lastLoginAt)}</td>
      <td>
        <button type="button" className={account.disabled ? undefined : 'danger'} disabled={update.isPending} onClick={toggleDisabled}>
          {account.disabled ? '다시 사용' : '사용 중지'}
        </button>
      </td>
    </tr>
  );
}

/**
 * 계정·역할 관리(ADMIN, 보강 5 — api는 보강 2의 /admin/accounts, decisions/0052). 목록·만들기·역할 바꾸기·사용 중지.
 * 외부 업체 키 발급·폐기는 개발자센터 화면(보강 7)이 맡는다(decisions/0069) — 여기서는 안내만.
 */
export function AccountsPage() {
  const me = useMe();
  const accounts = useQuery({ queryKey: keys.accounts.all, queryFn: () => api<AccountView[]>('/admin/accounts') });
  const merchants = useQuery({ queryKey: keys.merchants, queryFn: () => api<MerchantView[]>('/merchants'), staleTime: Infinity });
  return (
    <section>
      <h2>계정</h2>
      <p className="hint">
        역할·가맹점·사용 여부를 바꾸면 그 계정의 로그인이 모두 끊겨 다시 로그인해야 새 권한이 적용됩니다. 마지막 활성 관리자(ADMIN)는 내리거나 중지할 수 없습니다.
      </p>
      <CreateAccountForm merchants={merchants.data} />
      <ErrorBox error={accounts.error ?? merchants.error} />
      {accounts.data ? (
        <table>
          <thead>
            <tr>
              <th scope="col">아이디</th>
              <th scope="col">이름</th>
              <th scope="col">역할</th>
              <th scope="col">상태</th>
              <th scope="col">마지막 로그인</th>
              <th scope="col">사용</th>
            </tr>
          </thead>
          <tbody>
            {accounts.data.map((a) => (
              // 역할·가맹점이 서버에서 바뀌면 줄을 새로 그려 고르던 칸을 서버 값으로 맞춘다
              <AccountRow key={`${a.id}-${a.role}-${a.merchantCode ?? ''}-${a.disabled}`} account={a} me={me?.loginId} merchants={merchants.data} />
            ))}
          </tbody>
        </table>
      ) : accounts.isPending ? (
        <p className="muted">불러오는 중</p>
      ) : null}
      <div className="panel" aria-label="외부 업체 키">
        <h3>외부 업체 키</h3>
        <p className="muted">외부 업체(가상) API 키 발급·폐기는 개발자센터 화면(보강 7)에서 합니다. 그 전까지는 API(<code>POST /admin/partner-keys</code>, <code>POST /admin/partner-keys/:id/revoke</code>)로 합니다.</p>
      </div>
    </section>
  );
}
