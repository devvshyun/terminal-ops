import type { BeforeIdPage, Carrier, CreateRolloutRequest, FirmwareView, InspectionItemView, OffsetPage, RolloutView, TerminalView, TicketView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { call } from './servers';

/**
 * 시연 홈의 실행 단추가 부르는 묶음(보강 10, decisions/0092). 모두 운영 API 그대로 — 로그인한 운영자 권한으로 전이 서비스·이력을 지난다.
 * 장애 손잡이는 가상 업체·시뮬레이터 관리 API(로그인 없음, decisions/0084).
 * 같은 막을 여러 번 돌려도 되게: 재고가 없으면 시연용 재고를 만들고, 펌웨어는 쓰지 않은 다음 버전을 고른다.
 */

/** 시연 홈이 만드는 재고의 시리얼 앞부분(시연 데이터 DM-0001…와 겹치지 않게 9000번대) */
const STOCK_PREFIX = 'DM-9';
const STOCK_MODEL = 'SN-100';

const page = <T,>(path: string, query: Record<string, string | number>) => api<OffsetPage<T>>(path, { query });
const versionOf = async (serialNo: string) => (await api<TerminalView>(`/terminals/${serialNo}`)).version;

/** 그 모델 재고(IN_STOCK) 한 대의 시리얼. 없으면 시연용 한 대를 만든다(등록 → 그 모델 검수 항목 모두 합격 → 재고) */
export async function ensureStock(modelCode = STOCK_MODEL): Promise<string> {
  const stock = await page<TerminalView>('/terminals', { status: 'IN_STOCK', modelCode, size: 50 });
  const first = stock.items.find((t) => t.serialNo.startsWith('DM-'));
  if (first) return first.serialNo;
  // 다음 빈 시리얼: 시연 홈이 만든 것(DM-9xxx) 중 가장 큰 번호 다음
  const made = await page<TerminalView>('/terminals', { q: STOCK_PREFIX, size: 100 });
  const max = Math.max(9000, ...made.items.map((t) => Number(t.serialNo.slice(3))).filter((n) => Number.isInteger(n)));
  const serialNo = `DM-${max + 1}`;
  await api('/terminals', { method: 'POST', body: { serialNo, modelCode } });
  const items = await api<InspectionItemView[]>('/inspection-items', { query: { modelCode } });
  const inspected = await api<{ terminal: TerminalView }>(`/terminals/${serialNo}/inspections`, {
    method: 'POST',
    body: { results: items.map((i) => ({ itemCode: i.code, passed: true })) },
  });
  await api(`/terminals/${serialNo}/transitions`, { method: 'POST', body: { to: 'IN_STOCK', reason: '재고 편입(시연 홈)', expectedVersion: inspected.terminal.version } });
  return serialNo;
}

/** 재고 한 대를 가맹점에 배정하고 택배로 출고한다 */
export async function shipOne(merchantCode: string, carrier: Carrier = 'BUNGAE'): Promise<{ serialNo: string; trackingNo: string }> {
  const serialNo = await ensureStock();
  await api(`/terminals/${serialNo}/allocations`, { method: 'POST', body: { merchantCode, expectedVersion: await versionOf(serialNo) } });
  const shipment = await api<{ trackingNo: string }>('/shipments', { method: 'POST', body: { serialNo, carrier, expectedVersion: await versionOf(serialNo) } });
  return { serialNo, trackingNo: shipment.trackingNo };
}

/** 그 모델에 등록된 가장 큰 x.y.0의 다음(y + 1). 없으면 1.1.0 */
export async function nextVersion(modelCode: string): Promise<string> {
  const list = await api<BeforeIdPage<FirmwareView>>('/firmware', { query: { modelCode, limit: 100 } });
  const minors = list.items
    .filter((f) => f.modelCode === modelCode)
    .map((f) => /^(\d+)\.(\d+)\.0$/.exec(f.version))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [Number(m[1]), Number(m[2])] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const top = minors.at(-1);
  return top ? `${top[0]}.${top[1] + 1}.0` : '1.1.0';
}

/**
 * 새 버전을 등록하고 배포를 시작한다(어드민 "새 배포 만들기"의 기본값).
 * 같은 모델에 진행 중(진행·멈춤) 배포가 있으면 등록 전에 멈춘다 — api는 배포를 409로 거절하는데 그 전에 등록한 버전이 남아,
 * 다시 누를 때마다 버전이 하나씩 늘었다(최종 검토)
 */
export async function startRollout(modelCode: string): Promise<RolloutView> {
  const active = (await api<BeforeIdPage<RolloutView>>('/firmware-rollouts', { query: { limit: 20 } })).items.find(
    (r) => r.modelCode === modelCode && (r.status === 'RUNNING' || r.status === 'PAUSED'),
  );
  if (active) throw new Error(`${modelCode}에 진행 중인 배포(${active.version})가 있습니다. 끝나거나 어드민 "펌웨어 배포"에서 중단한 뒤 다시 실행하세요.`);
  await powerOnInService(modelCode);
  const version = await nextVersion(modelCode);
  await api('/firmware', { method: 'POST', body: { modelCode, version } });
  const body: CreateRolloutRequest = { modelCode, version, stages: [10, 50, 100], failureThreshold: 0.2, minSamples: 5 };
  return api<RolloutView>('/firmware-rollouts', { method: 'POST', body });
}

/**
 * 운영 중(IN_SERVICE)인데 시뮬레이터가 모르는 단말기를 시뮬레이터에 더한다(켠다). 배포는 운영 중인 단말기를 대상으로 고르는데,
 * 시뮬레이터는 시연 데이터의 단말기 목록만 돈다 — 4막에서 점주가 설치를 확인한 교체품은 대상이 되지만 보고하지 않아, 그 단계가 시간 제한(10분)까지 멈췄다(troubleshooting/0040).
 * 실제로는 설치한 단말기가 켜지며 하트비트를 보낸다. 시뮬레이터가 목록 대신 개수로 만드는 모드(serials 빈 배열)면 건드리지 않는다
 */
export async function powerOnInService(modelCode: string): Promise<string[]> {
  const live = await page<TerminalView>('/terminals', { status: 'IN_SERVICE', modelCode, size: 100 });
  const sim = await call<{ serials: string[] }>('sim', '/__admin/config');
  if (sim.serials.length === 0) return [];
  const missing = live.items.map((t) => t.serialNo).filter((s) => !sim.serials.includes(s));
  if (missing.length > 0) await call('sim', '/__admin/config', { method: 'POST', body: { serials: [...sim.serials, ...missing] } });
  return missing;
}

/** 번개택배 추적 조회가 429를 낼 확률(0~1) */
export async function setBungae429(rate: number): Promise<void> {
  await call('partners', '/__admin/config', { method: 'POST', body: { bungae: { force429Rate: rate } } });
}

/** 시뮬레이터 단말기가 펌웨어 업데이트를 실패로 보고할 확률(0~1) */
export async function setFirmwareFailRate(rate: number): Promise<void> {
  await call('sim', '/__admin/config', { method: 'POST', body: { firmwareFailRate: rate } });
}

/** 단말기 하나를 끄거나 켠다 — 그때의 offlineSerials를 읽어 바꾼다(다른 꺼 둔 단말기를 덮지 않게) */
export async function setDeviceOffline(serialNo: string, offline: boolean): Promise<void> {
  const current = (await call<{ offlineSerials: string[] }>('sim', '/__admin/config')).offlineSerials.filter((s) => s !== serialNo);
  await call('sim', '/__admin/config', { method: 'POST', body: { offlineSerials: offline ? [...current, serialNo] : current } });
}

/** A/S: 원격 점검(해결 안 됨) → 고장 단말기와 같은 모델의 재고 한 대로 교체 출고(다른 모델이면 api가 MODEL_MISMATCH) */
export async function replaceForTicket(ticketId: number): Promise<TicketView> {
  const ticket = await api<TicketView>(`/service-tickets/${ticketId}`);
  const broken = await api<TerminalView>(`/terminals/${ticket.serialNo}`);
  await api(`/service-tickets/${ticketId}/remote-checks`, { method: 'POST', body: { resolved: false, note: '원격 점검(시연 홈): 해결 안 됨 — 교체' } });
  const replacementSerialNo = await ensureStock(broken.modelCode);
  return api<TicketView>(`/service-tickets/${ticketId}/replacements`, { method: 'POST', body: { replacementSerialNo, carrier: 'BUNGAE' } });
}
