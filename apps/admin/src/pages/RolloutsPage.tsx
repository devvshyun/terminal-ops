import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { itemsOf, useBeforeIdList } from '../api/lists';
import { ErrorBox } from '../components/ErrorBox';
import { MoreButton } from '../components/MoreButton';
import { WriteButton } from '../components/WriteButton';
import { formatKst } from '../lib/format';
import { label } from '../lib/labels';
import { keys } from '../api/query-keys';
import { hasRole, useMe } from '../session';
import { FirmwareRegisterForm, RolloutCreateForm } from './RolloutForms';
import type { RolloutStatus, RolloutView } from '@terminal-ops/contracts';

/** 배포 상태 이름. 키가 contracts RolloutStatus와 하나라도 다르면 tsc가 막는다 */
const ROLLOUT_STATUS_LABEL: Record<RolloutStatus, string> = {
  RUNNING: '진행 중',
  PAUSED: '멈춤',
  COMPLETED: '완료',
  ABORTED: '중단',
};

/** 펌웨어 단계 배포 현황(F8): 배포마다 단계별 대상·성공·실패·시간 초과, 멈춤·재개·중단. 운영자는 펌웨어 등록·배포 만들기도(보강 5) */
export function RolloutsPage() {
  const client = useQueryClient();
  const canWrite = hasRole(useMe(), ['OPERATOR']);
  /** 열어 둔 쓰기 폼(보강 5). 닫혀 있으면 모델·펌웨어 목록을 부르지 않는다 */
  const [open, setOpen] = useState<'firmware' | 'rollout' | null>(null);
  const [status, setStatus] = useState('');
  const list = useBeforeIdList<RolloutView>(keys.rollouts.all, '/firmware-rollouts', { status });
  const control = useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'pause' | 'resume' | 'abort' }) =>
      api<RolloutView>(`/firmware-rollouts/${id}/${action}`, { method: 'POST' }),
    // 실패(422 ROLLOUT_NOT_RUNNING 등)는 화면이 낡았다는 뜻일 수 있다: 오류 안내는 두고 목록을 다시 읽는다
    onSettled: () => client.invalidateQueries({ queryKey: keys.rollouts.all }),
  });
  const abort = (r: RolloutView) => {
    if (window.confirm(`배포 #${r.id} ${r.version}을(를) 중단할까요? 되돌릴 수 없습니다.`)) control.mutate({ id: r.id, action: 'abort' });
  };

  return (
    <section>
      <h2>펌웨어 배포</h2>
      {canWrite ? (
        <div className="actions">
          <button type="button" aria-expanded={open === 'firmware'} onClick={() => setOpen(open === 'firmware' ? null : 'firmware')}>
            펌웨어 등록
          </button>
          <button type="button" aria-expanded={open === 'rollout'} onClick={() => setOpen(open === 'rollout' ? null : 'rollout')}>
            새 배포 만들기
          </button>
        </div>
      ) : null}
      {open === 'firmware' ? <FirmwareRegisterForm /> : null}
      {open === 'rollout' ? <RolloutCreateForm /> : null}
      <div className="filters">
        <select aria-label="배포 상태" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">상태 전체</option>
          {Object.entries(ROLLOUT_STATUS_LABEL).map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void list.refetch()}>
          새로고침
        </button>
      </div>
      <ErrorBox error={list.error ?? control.error} />
      {itemsOf(list.data).map((r) => (
        <article key={r.id} className="panel" aria-label={`배포 ${r.id}`}>
          <h3>
            #{r.id} {r.modelCode} {r.version} <span className="badge">{label(ROLLOUT_STATUS_LABEL, r.status)}</span>
          </h3>
          <p className="muted">
            {r.stages.join('% → ')}% · 지금 {r.currentStage + 1}단계({formatKst(r.stageStartedAt)}부터) · 실패율 기준 {Math.round(r.failureThreshold * 100)}%, 최소 {r.minSamples}건 ·{' '}
            {r.createdBy} {formatKst(r.createdAt)}
            {r.finishedAt ? ` · 끝 ${formatKst(r.finishedAt)}` : ''}
          </p>
          {r.endReason ? <p>끝난 이유: {r.endReason}</p> : null}
          <table>
            <thead>
              <tr>
                <th scope="col">단계</th>
                <th scope="col">누적 %</th>
                <th scope="col">대상</th>
                <th scope="col">보고 대기</th>
                <th scope="col">성공</th>
                <th scope="col">실패</th>
                <th scope="col">시간 초과</th>
              </tr>
            </thead>
            <tbody>
              {r.stageStats.map((s) => (
                <tr key={s.stage} aria-current={s.stage === r.currentStage ? 'step' : undefined}>
                  <td>{s.stage + 1}</td>
                  <td>{s.percent}</td>
                  <td>{s.targets}</td>
                  <td>{s.offered}</td>
                  <td className="ok">{s.succeeded}</td>
                  <td className={s.failed > 0 ? 'bad' : undefined}>{s.failed}</td>
                  <td>{s.timedOut}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="actions">
            {r.status === 'RUNNING' ? (
              <WriteButton disabled={control.isPending} onClick={() => control.mutate({ id: r.id, action: 'pause' })}>
                멈춤
              </WriteButton>
            ) : null}
            {r.status === 'PAUSED' ? (
              <WriteButton disabled={control.isPending} onClick={() => control.mutate({ id: r.id, action: 'resume' })}>
                재개
              </WriteButton>
            ) : null}
            {r.status === 'RUNNING' || r.status === 'PAUSED' ? (
              <WriteButton className="danger" disabled={control.isPending} onClick={() => abort(r)}>
                중단
              </WriteButton>
            ) : null}
          </div>
        </article>
      ))}
      <MoreButton hasNextPage={list.hasNextPage} isFetchingNextPage={list.isFetchingNextPage} fetchNextPage={list.fetchNextPage} />
    </section>
  );
}
