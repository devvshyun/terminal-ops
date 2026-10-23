/**
 * 원시 SQL(em.execute) 결과의 datetime 글자를 Date로 바꾼다.
 * MikroORM 7은 forceUtcTimezone(기본 켜짐)으로 날짜를 **UTC**로 쓰고, 원시 결과는 dateStrings라 'YYYY-MM-DD HH:mm:ss.SSS'
 * 글자(시간대 표시 없음)로 돌려준다. `new Date(글자)`는 이것을 서버 지역 시간(KST)으로 읽어 9시간 어긋난다(사전 검증).
 * 엔티티로 읽는 값은 MikroORM이 바꿔 주므로 이 함수가 필요 없다. SQL 안에서 NOW()와 비교하지 않는 것도 같은 이유다(세션 시간대 SYSTEM).
 */
export function fromDbDatetime(value: string | Date): Date {
  if (value instanceof Date) return value;
  return new Date(`${value.replace(' ', 'T')}Z`);
}
