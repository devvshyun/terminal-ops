import { VanMismatchKind } from './van.entities.js';

/**
 * 알림·리포트·화면에 쓰는 어긋남 종류의 짧은 이름. 상수만 두는 파일이다 — outbox·report가 비교 로직(van-compare.ts)을
 * 불러오지 않게 떼어 냈다(Day 5 최종 리뷰 Minor 5, decisions/0037).
 */
export const KIND_LABEL: Record<VanMismatchKind, string> = {
  [VanMismatchKind.NOT_REGISTERED]: '미등록',
  [VanMismatchKind.REGISTERED_BUT_NOT_IN_SERVICE]: '운영 아님',
  [VanMismatchKind.MERCHANT_MISMATCH]: '가맹점 다름',
  [VanMismatchKind.SUSPENDED_WHILE_IN_SERVICE]: '정지',
};
