import { demoSeedAllowed } from './seed-accounts.js';

/**
 * 시연 데이터의 "지난 일"(decisions/0091). 띄운 직후 어드민 처음 화면의 오래 오프라인·배송 뒤 설치 안 됨 카드가 0이 아니게,
 * 시연 단말기 두 대의 시각만 며칠 앞으로 옮긴다. 상태는 바꾸지 않는다 — 상태 변경은 앞 단계가 실제 HTTP API(전이 서비스)로 이미 했다.
 *
 * 0089(시각을 고치지 않는다)를 이 두 대에 한해 뒤집는다. 그래서 좁게 둔다:
 * - 고치는 단말기는 아래 PAST_TERMINALS 두 시리얼뿐(WHERE serial_no = ?). 다른 단말기·다른 표는 건드리지 않는다
 * - 운영(NODE_ENV=production)·SEED_DEMO=0이면 아무것도 하지 않는다(시나리오 전체도 돌지 않지만 여기서 한 번 더 막는다)
 * - 한 번만: 이미 옮겼으면(status_changed_at이 목표보다 이르면) 그 단말기의 UPDATE는 0행이다
 */

/** 운영 중인데 며칠째 하트비트가 없는 단말기(SN-200, 역삼카페). 시뮬레이터에서 늘 꺼 둔다 */
export const PAST_OFFLINE_SERIAL = 'DM-0021';
/** 배송 완료 뒤 설치되지 않은 단말기(SN-100, 판교분식) */
export const PAST_DELIVERED_SERIAL = 'DM-0022';

export interface PastTerminal {
  serialNo: string;
  /** 지금 상태가 된 지 며칠 전으로 옮기나(이력·운송장도 같은 만큼 앞으로) */
  daysAgo: number;
  /** 마지막 하트비트를 며칠 전으로 둘까(접속 기록을 만든다). 없으면 접속 기록을 만들지 않는다 */
  lastSeenDaysAgo?: number;
}

/**
 * 기준일(ANOMALY_OFFLINE_DAYS 기본 3, ANOMALY_DELIVERED_DAYS 기본 7)보다 하루 더. 기준일을 바꾼 환경이면 걸리지 않을 수 있다 — 시연 묶음은 기본값.
 * 오프라인 단말기는 4일 전 운영 시작, 그 뒤 몇 시간 하트비트를 보내다 끊긴 것으로 둔다(마지막 하트비트도 기준보다 전).
 */
export const PAST_TERMINALS: PastTerminal[] = [
  { serialNo: PAST_OFFLINE_SERIAL, daysAgo: 5, lastSeenDaysAgo: 4 },
  { serialNo: PAST_DELIVERED_SERIAL, daysAgo: 8 },
];

const DAY_MS = 86_400_000;
/** 오프라인 판정이 마지막 하트비트 뒤 이만큼 지나 기록한 것으로 둔다(HEARTBEAT_OFFLINE_AFTER_MS 기본값) */
const OFFLINE_DETECTED_AFTER_MS = 90_000;
/** 마지막으로 보고한 펌웨어(시연 SN-200의 지난 버전 — 배포 중인 2.1.0의 전) */
export const PAST_OFFLINE_FIRMWARE = '2.0.0';

export interface PastStatement {
  sql: string;
  params: unknown[];
}

/**
 * 한 단말기를 며칠 앞으로 옮기는 SQL. 이력·운송장·택배 이벤트·단말기 행 순서다 — 앞의 셋이 terminal.status_changed_at(옮기기 전 값)과의
 * 차이로 옮기므로 단말기 행이 마지막이어야 한다. 모두 `t.status_changed_at > 목표`일 때만이라 두 번째 실행은 0행이다.
 * 옮기는 양 = status_changed_at − 목표(마이크로초). 단말기 안의 시각 간격(등록 → 검수 → … → 지금 상태)은 그대로다.
 */
export function backdateStatements(p: PastTerminal, now: Date): PastStatement[] {
  const target = new Date(now.getTime() - p.daysAgo * DAY_MS);
  const shift = (col: string) => `${col} = ${col} - interval timestampdiff(microsecond, ?, t.status_changed_at) microsecond`;
  const guard = 't.serial_no = ? and t.status_changed_at > ?';
  const out: PastStatement[] = [
    {
      sql: `update terminal_status_history h join terminal t on t.id = h.terminal_id set ${shift('h.occurred_at')} where ${guard}`,
      params: [target, p.serialNo, target],
    },
    {
      sql: `update carrier_event e join shipment s on s.id = e.shipment_id join terminal t on t.id = s.terminal_id
               set ${shift('e.occurred_at')}, ${shift('e.received_at')} where ${guard}`,
      params: [target, target, p.serialNo, target],
    },
    {
      sql: `update shipment s join terminal t on t.id = s.terminal_id
               set ${shift('s.created_at')}, s.delivered_at = s.delivered_at - interval timestampdiff(microsecond, ?, t.status_changed_at) microsecond,
                   s.last_synced_at = s.last_synced_at - interval timestampdiff(microsecond, ?, t.status_changed_at) microsecond
             where ${guard}`,
      params: [target, target, target, p.serialNo, target],
    },
    {
      // 한 표 UPDATE의 SET은 왼쪽부터 차례로 계산되고 뒤 식은 앞에서 바뀐 값을 본다 — created_at을 status_changed_at보다 먼저
      sql: `update terminal t set ${shift('t.created_at')}, t.status_changed_at = ? where ${guard}`,
      params: [target, target, p.serialNo, target],
    },
  ];
  if (p.lastSeenDaysAgo !== undefined) {
    const lastSeen = new Date(now.getTime() - p.lastSeenDaysAgo * DAY_MS);
    // 하트비트를 보낸 적이 없는 단말기라 행이 없다. 이미 있으면(누가 시뮬레이터로 켰다) 그대로 둔다 — 새 값을 옛 값으로 덮지 않는다
    out.push({
      sql: `insert ignore into device_connectivity (terminal_id, online, last_seen_at, firmware_version, changed_at)
            select t.id, 0, ?, ?, ? from terminal t where t.serial_no = ?`,
      params: [lastSeen, PAST_OFFLINE_FIRMWARE, new Date(lastSeen.getTime() + OFFLINE_DETECTED_AFTER_MS), p.serialNo],
    });
  }
  return out;
}

/** 지난 일을 쓰는 손: MySQL 한 문장, Redis 오프라인 기록(SET) 더하기 */
export interface PastWriter {
  execute(sql: string, params: unknown[]): Promise<unknown>;
  /**
   * 오프라인 판정 job이 했을 일을 Redis에도 맞춘다: 오프라인 기록 SET에 넣는다. 안 넣으면 시연 중 이 단말기를 시뮬레이터로 켰을 때
   * 판정 job이 "다시 온라인"을 알아채지 못해 MySQL online이 0으로 남는다(판정은 SET에 있는 것만 온라인으로 되돌린다, decisions/0029)
   */
  markOffline(serials: string[]): Promise<void>;
}

/**
 * 지난 일을 쓴다. 시연이 허용된 환경에서만(운영이면 아무것도 하지 않고 false).
 * @returns 썼으면 true
 */
export async function writePast(writer: PastWriter, now = new Date(), env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (!demoSeedAllowed(env)) return false;
  for (const p of PAST_TERMINALS) {
    for (const s of backdateStatements(p, now)) await writer.execute(s.sql, s.params);
  }
  await writer.markOffline(PAST_TERMINALS.filter((p) => p.lastSeenDaysAgo !== undefined).map((p) => p.serialNo));
  return true;
}
