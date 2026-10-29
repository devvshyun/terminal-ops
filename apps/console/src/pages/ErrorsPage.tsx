import { useQuery } from '@tanstack/react-query';
import type { OpsErrorView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { Freshness } from '../components/Freshness';
import { ERROR_SOURCE_LABEL } from '../lib/labels';
import { useRefetchInterval } from '../lib/refresh';
import { When } from './DashboardPage';

/**
 * 최근 오류(보강 6, decisions/0070): 택배 수집 실패·VAN 대조 실패·주간 리포트 보내기 실패·알림 실패를 시각 순으로 30건.
 * 끝나면 지워지는 job의 실패는 실패 job 화면에 없고 여기에 업무 기록으로 보인다.
 */
export function ErrorsPage() {
  const refetchInterval = useRefetchInterval();
  const list = useQuery({ queryKey: keys.errors, queryFn: () => api<OpsErrorView[]>('/ops/errors'), refetchInterval });
  const now = new Date(list.dataUpdatedAt || Date.now());
  return (
    <>
      <h1>최근 오류</h1>
      <Freshness updatedAt={list.dataUpdatedAt} fetching={list.isFetching} error={list.error} />
      {list.data && list.data.length === 0 ? <p>최근 오류가 없습니다.</p> : null}
      {list.data && list.data.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>시각</th>
              <th>출처</th>
              <th>무엇</th>
              <th>오류</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((e) => (
              <tr key={`${e.source}-${e.id}`}>
                <td>
                  <When iso={e.at} now={now} />
                </td>
                <td>{ERROR_SOURCE_LABEL[e.source]}</td>
                <td>{e.title}</td>
                <td>
                  <pre>{e.message}</pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}
