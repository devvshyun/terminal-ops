import { CronExpressionParser } from 'cron-parser';

/** cron 주기 작업의 시간대. 서버 시간대와 상관없이 한국 시간으로 돈다(decisions/0035) */
export const CRON_TZ = 'Asia/Seoul';

/**
 * cron 식 환경변수를 읽는다. 없거나 빈 글자(공백)면 기본값. 분 시 일 월 요일 다섯 칸이 아니거나(`@daily` 같은 별칭, 초가 붙은 여섯 칸 포함)
 * BullMQ와 같은 파서(cron-parser, BullMQ가 쓰는 판과 같게 고정)가 Asia/Seoul로 읽지 못하면 던진다(서버·워커가 뜨지 않게).
 * BullMQ는 네 칸 `0 2 * *`를 "매달 2일 00:00"으로, `@daily`를 00:00으로 조용히 받아 엉뚱한 시각에 돌렸다(decisions/0035 갱신).
 * @param source 테스트에서 process.env 대신 넘긴다
 */
export function cronFromEnv(name: string, fallback: string, source: NodeJS.ProcessEnv = process.env): string {
  const text = (source[name] ?? '').trim();
  if (text === '') return fallback;
  const fields = text.split(/\s+/);
  const fail = (why: string) =>
    new Error(`환경변수 ${name}=${JSON.stringify(source[name])}는 cron 식이 아닙니다(${why}). 분 시 일 월 요일 다섯 칸으로 쓰세요. 저장소 루트 .env를 확인하세요.`);
  if (text.startsWith('@')) throw fail('@ 별칭은 받지 않음');
  if (fields.length !== 5) throw fail(`${fields.length}칸`);
  try {
    CronExpressionParser.parse(text, { tz: CRON_TZ });
  } catch (error) {
    throw fail(error instanceof Error ? error.message : String(error));
  }
  return fields.join(' ');
}

/** pattern(Asia/Seoul)의 from 바로 다음 실행 시각. BullMQ job scheduler의 next와 같은 계산(같은 파서) */
export function nextCronRun(pattern: string, from: Date): Date {
  return CronExpressionParser.parse(pattern, { tz: CRON_TZ, currentDate: from }).next().toDate();
}
