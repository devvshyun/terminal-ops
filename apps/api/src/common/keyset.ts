import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * 최근 것부터 보는 목록의 페이지 조건(어드민 화면의 "더 보기", decisions/0039).
 * beforeId보다 작은 id를 id 내림차순으로 limit개 — offset이 아니라 PK 범위라 몇 번째 쪽이든 같은 비용이다.
 * 이상 단말기·VAN 결과(afterId, 오름차순)와 방향만 다르다: 실행·접수 이력은 최근 것을 먼저 본다.
 * 목록 쿼리는 연관(모델·단말기 등)을 select-in으로 읽는다 — joined면 옵티마이저가 PK 역순 읽기를 버리고 조인 뒤 정렬할 수 있다(실험 0013).
 */
export class BeforeIdQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER) // 넘으면 Number로 바꿀 때 값이 뭉개진다(2^53 이상)
  beforeId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

/** limit + 1개를 읽어 다음 쪽이 있는지 본다. 다음 쪽이 있으면 nextBeforeId = 이 쪽 마지막 id */
export function keysetPage<T extends { id: number }>(rows: T[], limit: number): { items: T[]; nextBeforeId: number | null } {
  const items = rows.slice(0, limit);
  return { items, nextBeforeId: rows.length > limit ? items.at(-1)!.id : null };
}

/** where에 붙일 id 조건 */
export const beforeIdWhere = (beforeId?: number) => (beforeId ? { id: { $lt: beforeId } } : {});
