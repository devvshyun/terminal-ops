import type { Migration } from '@mikro-orm/migrations';

/** enum을 좁히는 down이 남길 값들(이 밖의 값이 든 행이 있으면 좁힐 수 없다) */
export interface EnumNarrowing {
  table: string;
  column: string;
  keep: readonly string[];
}

/**
 * enum을 좁히는 down의 사전 검사(최종 리뷰 Minor 3, troubleshooting/0025). 좁힌 enum 밖의 값이 든 행이 있으면 DDL을 쌓기 전에 던진다.
 * MySQL DDL은 암묵 커밋이라 마이그레이션 트랜잭션이 되돌리지 못한다. 검사 없이 ALTER를 보내면 strict 모드 ERROR 1265로
 * 둘째 ALTER가 실패할 때 첫째 ALTER만 반영된 채 마이그레이션은 "적용됨"으로 남는다. 행을 바꾸거나 지우지는 않는다(사람이 정한다).
 * 이 파일은 마이그레이션 폴더 밖에 둔다 — dist/migrations의 모든 .js를 마이그레이션으로 읽기 때문이다.
 */
export async function assertEnumNarrowable(migration: Migration, name: string, narrowings: readonly EnumNarrowing[]): Promise<void> {
  const problems: string[] = [];
  for (const { table, column, keep } of narrowings) {
    const list = keep.map((v) => `'${v}'`).join(', ');
    const [row] = await migration.execute(`select count(*) as c from \`${table}\` where \`${column}\` not in (${list})`);
    const count = Number((row as { c?: unknown } | undefined)?.c ?? 0);
    if (count > 0) problems.push(`${table}.${column}에 (${keep.join(', ')}) 밖의 값 ${count}행`);
  }
  if (problems.length > 0) {
    throw new Error(`${name} down을 할 수 없습니다: ${problems.join(', ')}. 되돌리기 전에 그 행을 처리하세요(아무 ALTER도 보내지 않았습니다).`);
  }
}
