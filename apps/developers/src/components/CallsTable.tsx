import type { PartnerCallView } from '@terminal-ops/contracts';
import { formatKst } from '../lib/format';
import { codeClass } from '../lib/labels';

/** 호출 기록 표(호출 로그 화면·업체 화면 아래 최근 호출이 같이 쓴다). 업체 열은 전체 로그에서만 */
export function CallsTable({ label, calls, showPartner }: { label: string; calls: PartnerCallView[]; showPartner: boolean }) {
  return (
    <table aria-label={label}>
      <thead>
        <tr>
          <th scope="col">시각</th>
          {showPartner ? <th scope="col">업체</th> : null}
          <th scope="col">키</th>
          <th scope="col">요청</th>
          <th scope="col">상태</th>
          <th scope="col" className="num">
            걸린 시간
          </th>
        </tr>
      </thead>
      <tbody>
        {calls.map((c) => (
          <tr key={c.id}>
            <td className="time">{formatKst(c.createdAt)}</td>
            {showPartner ? <td className="mono strong">{c.partnerCode}</td> : null}
            <td className="mono">{c.keyPrefix}</td>
            <td className="mono">
              <span className="method">{c.method}</span> {c.path}
            </td>
            <td>
              <span className={`code ${codeClass(c.status)}`}>{c.status}</span>
            </td>
            <td className="num">{c.durationMs}ms</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
