import { kstDate, KST_OFFSET_MS, toKstWallClock } from '../common/kst.js';
import { DAY_MS } from '../config/env-number.js';

// KST 날짜 글자는 알림 문구의 formatKst와 같은 모듈(common/kst.ts)에서 가져온다(한 곳, fix 커밋과 합침)
export { kstDate };

/** 한 주: KST 월요일 00:00부터 다음 월요일 00:00 전까지. from·to는 그 순간의 UTC 시각(DB 비교용, [from, to)) */
export interface KstWeek {
  /** 그 주 월요일의 KST 날짜 'YYYY-MM-DD' */
  weekStart: string;
  from: Date;
  to: Date;
}

/**
 * instant가 속한 KST 주. DB는 UTC로 저장하므로(MikroORM forceUtcTimezone) 경계는 "KST 월요일 00:00 = 전날 15:00 UTC"다.
 * 서버 시간대(process TZ)에 기대지 않으려고 getUTC*만 쓴다(troubleshooting/0016과 같은 교훈, decisions/0035).
 */
export function kstWeekOf(instant: Date): KstWeek {
  const k = toKstWallClock(instant); // KST 벽시계를 UTC 필드로 읽는다
  const sinceMonday = (k.getUTCDay() + 6) % 7; // 월 0 … 일 6
  const mondayKstAsUtc = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate() - sinceMonday);
  const from = new Date(mondayKstAsUtc - KST_OFFSET_MS);
  return { weekStart: kstDate(from), from, to: new Date(from.getTime() + 7 * DAY_MS) };
}

/** instant 바로 앞 주(주간 리포트는 월요일 09:00 KST에 지난주를 낸다) */
export function previousKstWeek(instant: Date): KstWeek {
  return kstWeekOf(new Date(kstWeekOf(instant).from.getTime() - 1));
}

/** 'YYYY-MM-DD'(KST 월요일) → 그 주. 날짜가 아니거나 월요일이 아니면 null */
export function parseKstWeekStart(text: string): KstWeek | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const asUtc = new Date(Date.UTC(y, mo - 1, d));
  if (asUtc.getUTCFullYear() !== y || asUtc.getUTCMonth() !== mo - 1 || asUtc.getUTCDate() !== d) return null; // 2026-02-30 등
  const week = kstWeekOf(new Date(asUtc.getTime() - KST_OFFSET_MS));
  return week.weekStart === text ? week : null;
}
