import { useQuery } from '@tanstack/react-query';
import type { OpsSchedulerView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { Freshness } from '../components/Freshness';
import { scheduleText } from '../lib/labels';
import { useRefetchInterval } from '../lib/refresh';
import { When } from './DashboardPage';

/**
 * 주기 작업(보강 6): 코드의 목록(JOB_SCHEDULERS) 순서대로 큐·job·주기·Redis 등록 여부·다음 실행 시각.
 * 등록 안 됨 = RUN_SCHEDULERS=1인 프로세스가 아직 안 떴거나 scheduler:clear로 지운 것. 코드에 없음 = Redis에만 남은 옛 주기 작업.
 */
export function SchedulersPage() {
  const refetchInterval = useRefetchInterval();
  const list = useQuery({ queryKey: keys.schedulers, queryFn: () => api<OpsSchedulerView[]>('/ops/schedulers'), refetchInterval });
  const now = new Date(list.dataUpdatedAt || Date.now());
  return (
    <>
      <h1>주기 작업</h1>
      <Freshness updatedAt={list.dataUpdatedAt} fetching={list.isFetching} error={list.error} />
      {list.data ? (
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>큐 / job</th>
              <th>주기</th>
              <th>등록</th>
              <th>다음 실행</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((s) => (
              <tr key={`${s.queue}/${s.id}`}>
                <td>
                  {s.id} {s.defined ? null : <span className="badge warn">코드에 없음</span>}
                </td>
                <td>
                  {s.queue} / {s.jobName}
                </td>
                <td>{scheduleText(s)}</td>
                <td>{s.registered ? <span className="badge ok">등록됨</span> : <span className="badge bad">등록 안 됨</span>}</td>
                <td>
                  <When iso={s.nextRunAt} now={now} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}
