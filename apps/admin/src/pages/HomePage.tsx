import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { ErrorBox } from '../components/ErrorBox';
import { keys } from '../api/query-keys';

/** 처음 화면: api 연결 확인(GET /health)과 사용 안내 */
export function HomePage() {
  const health = useQuery({ queryKey: keys.health, queryFn: () => api<{ status: string }>('/health') });
  return (
    <section>
      <h2>처음</h2>
      <p>
        api 연결:{' '}
        {health.isPending ? '확인 중' : health.isError ? '실패' : <strong className="ok">{health.data.status}</strong>}
      </p>
      <ErrorBox error={health.error} />
      <ul className="hint">
        <li>시각은 모두 한국 시간(KST)으로 보여 줍니다.</li>
        <li>바꾸는 작업(전이·스캔·A/S 등)은 위쪽에 작업자 이름을 저장해야 할 수 있습니다. 이름은 이력에 남습니다.</li>
      </ul>
    </section>
  );
}
