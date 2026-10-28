import type { MerchantConnectivity, MerchantShipmentView, TerminalStatus } from '@terminal-ops/contracts';
import { agoText, formatKst } from '../lib/format';
import { CARRIER_LABEL, TERMINAL_STATUS_LABEL, TERMINAL_STATUS_TONE } from '../lib/labels';
import { shipmentSteps } from '../lib/steps';
import { currentStep } from './StepList';

/** 상태 배지(점주 말, 색은 TERMINAL_STATUS_TONE) */
export function StatusBadge({ status }: { status: TerminalStatus }) {
  return <span className={`badge ${TERMINAL_STATUS_TONE[status] ?? ''}`}>{TERMINAL_STATUS_LABEL[status]}</span>;
}

/** 접속 한 줄: ● 연결됨/연결 끊김 · 마지막 접속 N분 전. 기록이 없으면 "접속 기록 없음" */
export function ConnectivityLine({ c, now }: { c: MerchantConnectivity; now: Date }) {
  if (!c.lastSeenAt) {
    return (
      <span>
        <span className="dot" aria-hidden />
        접속 기록 없음
      </span>
    );
  }
  return (
    <span title={formatKst(c.lastSeenAt)}>
      <span className={`dot ${c.online ? 'on' : 'off'}`} aria-hidden />
      {c.online ? '연결됨' : '연결 끊김'} · 마지막 접속 {agoText(c.lastSeenAt, now)}
    </span>
  );
}

/** 운송장 한 줄: 택배사 운송장번호 · 지금 단계 */
export function ShipmentLine({ s }: { s: MerchantShipmentView }) {
  return (
    <span>
      {CARRIER_LABEL[s.carrier]} {s.trackingNo} · {currentStep(shipmentSteps(s))}
    </span>
  );
}
