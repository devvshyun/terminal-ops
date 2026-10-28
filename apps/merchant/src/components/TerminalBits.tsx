import type { MerchantConnectivity, MerchantShipmentView, MerchantTerminalView, TerminalStatus } from '@terminal-ops/contracts';
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

/** 배송이 끝난(DELIVERED) 단말기의 설치 안내 — 교체 단말기면 A/S 화면의 설치 확인으로 안내 */
export function DeliveredHint({ t }: { t: Pick<MerchantTerminalView, 'status' | 'shipment'> }) {
  if (t.status !== 'DELIVERED') return null;
  return <div className="muted">{t.shipment?.ticketId ? '설치한 뒤 A/S 화면에서 설치 확인을 눌러 주세요.' : '설치가 끝나면 사용 중으로 바뀝니다.'}</div>;
}

/** 운송장 한 줄: 택배사 운송장번호 · 지금 단계 */
export function ShipmentLine({ s }: { s: MerchantShipmentView }) {
  return (
    <span>
      {CARRIER_LABEL[s.carrier]} {s.trackingNo} · {currentStep(shipmentSteps(s))}
    </span>
  );
}
