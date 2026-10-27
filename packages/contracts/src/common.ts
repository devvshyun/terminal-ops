import type { RowResultCode } from './statuses.js';

/** 최근 것부터 "더 보기" 목록(?beforeId=&limit=, id 내림차순 키셋, decisions/0039) */
export interface BeforeIdPage<T> {
  items: T[];
  /** 다음 쪽이 있으면 이 쪽 마지막 id, 없으면 null */
  nextBeforeId: number | null;
}

/** 오래된 것부터 이어 보는 목록(?afterId=&limit=, id 오름차순 키셋 — 이상 단말기·VAN 결과, decisions/0033) */
export interface AfterIdPage<T> {
  items: T[];
  nextAfterId: number | null;
}

/** 쪽 번호 목록(단말기 목록, ?page=&size=, decisions/0039) */
export interface OffsetPage<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

/** 일괄 처리(박스 스캔·엑셀 등록)의 행 하나의 결과. 요청의 행 순서 그대로 준다 */
export interface RowResult {
  serialNo: string;
  result: RowResultCode;
  message?: string;
}
