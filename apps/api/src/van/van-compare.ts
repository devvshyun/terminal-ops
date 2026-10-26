import { TerminalStatus } from '../terminal/terminal-status.js';
import { VanMismatchKind, VanStatus } from './van.entities.js';

/** 우리 쪽: 단말기 상태와 배정 가맹점 코드(없으면 null) */
export interface OurSide {
  status: TerminalStatus;
  merchantCode: string | null;
}

/** VAN 쪽: 등록 상태와 가맹점 코드 */
export interface VanSide {
  status: VanStatus;
  merchantCode: string;
}

/**
 * 한 시리얼의 어긋남 종류. 어긋나지 않으면 null. 집합 비교 SQL(후보 거르기)과 재검증이 같은 함수로 종류를 정한다(decisions/0033).
 * 대조 키는 시리얼, 가맹점은 merchant.code로 비교한다(VAN tid는 참고값).
 * 우선순위: 우리가 운영 중이면 VAN 없음·해지 → NOT_REGISTERED, 정지 → SUSPENDED_WHILE_IN_SERVICE, 활성인데 가맹점 다름 → MERCHANT_MISMATCH.
 * 우리가 운영 중이 아니면(또는 단말기가 없으면) VAN 활성 → REGISTERED_BUT_NOT_IN_SERVICE. 둘 다 비활성이면 어긋남이 아니다.
 */
export function classify(our: OurSide | null, van: VanSide | null): VanMismatchKind | null {
  const inService = our?.status === TerminalStatus.IN_SERVICE;
  if (inService) {
    if (!van || van.status === VanStatus.CANCELLED) return VanMismatchKind.NOT_REGISTERED;
    if (van.status === VanStatus.SUSPENDED) return VanMismatchKind.SUSPENDED_WHILE_IN_SERVICE;
    return our!.merchantCode === van.merchantCode ? null : VanMismatchKind.MERCHANT_MISMATCH;
  }
  return van?.status === VanStatus.ACTIVE ? VanMismatchKind.REGISTERED_BUT_NOT_IN_SERVICE : null;
}

export function ourValueOf(our: OurSide | null): string {
  return our ? `${our.status} / ${our.merchantCode ?? '가맹점 없음'}` : '우리 DB에 없음';
}

export function vanValueOf(van: VanSide | null): string {
  return van ? `${van.status} / ${van.merchantCode}` : 'VAN에 없음';
}

/** 알림·리포트에 쓰는 짧은 이름 */
export const KIND_LABEL: Record<VanMismatchKind, string> = {
  [VanMismatchKind.NOT_REGISTERED]: '미등록',
  [VanMismatchKind.REGISTERED_BUT_NOT_IN_SERVICE]: '운영 아님',
  [VanMismatchKind.MERCHANT_MISMATCH]: '가맹점 다름',
  [VanMismatchKind.SUSPENDED_WHILE_IN_SERVICE]: '정지',
};
