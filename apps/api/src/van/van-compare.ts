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
 * 대조 키 정규화: 앞뒤 공백을 지우고 대문자로. 테이블 collation(utf8mb4_0900_ai_ci)이 대소문자를 구분하지 않아 SQL 비교·스테이징 PK·
 * terminal.serial_no unique가 모두 'vr-001'과 'VR-001'을 같게 본다 — TS 쪽 Map 키·비교도 같은 동치를 쓴다(decisions/0033).
 * (SQL에 COLLATE utf8mb4_bin을 붙이는 쪽은 버렸다: terminal.serial_no 인덱스를 못 타고, 우리 DB가 이미 같다고 보는 값을 다르다고 하게 된다.)
 * 시리얼·가맹점 코드는 ASCII라 악센트 무시는 따로 다루지 않는다. 앞뒤 공백은 collation이 NO PAD라 SQL도 다르게 보므로 수집할 때 지운다.
 */
export function serialKey(value: string): string {
  return value.trim().toUpperCase();
}

const VAN_STATUS_RANK: Record<VanStatus, number> = { [VanStatus.ACTIVE]: 0, [VanStatus.SUSPENDED]: 1, [VanStatus.CANCELLED]: 2 };

/**
 * 같은 시리얼(serialKey 기준)의 VAN 등록이 둘 이상일 때 쓸 하나. 가정은 "VAN에서 시리얼은 유일"이고, 어긋나면 이 규칙으로 고른다:
 * ACTIVE > SUSPENDED > CANCELLED, 같으면 updatedAt이 나중인 것(같으면 a). 수집(페이지 안·페이지 사이)과 단건 조회가 같은 규칙을 쓴다(decisions/0033).
 */
export function betterRegistration<T extends { status: VanStatus; updatedAt: Date }>(a: T, b: T): T {
  const ra = VAN_STATUS_RANK[a.status];
  const rb = VAN_STATUS_RANK[b.status];
  if (ra !== rb) return ra < rb ? a : b;
  return b.updatedAt.getTime() > a.updatedAt.getTime() ? b : a;
}

/**
 * 한 시리얼의 어긋남 종류. 어긋나지 않으면 null. 집합 비교 SQL(후보 거르기)과 재검증이 같은 함수로 종류를 정한다(decisions/0033).
 * 대조 키는 시리얼, 가맹점은 merchant.code로 비교한다(VAN tid는 참고값). 가맹점도 SQL과 같게 serialKey로 정규화해 비교한다.
 * 우선순위: 우리가 운영 중이면 VAN 없음·해지 → NOT_REGISTERED, 정지 → SUSPENDED_WHILE_IN_SERVICE, 활성인데 가맹점 다름 → MERCHANT_MISMATCH.
 * 우리가 운영 중이 아니면(또는 단말기가 없으면) VAN 활성 → REGISTERED_BUT_NOT_IN_SERVICE. 둘 다 비활성이면 어긋남이 아니다.
 */
export function classify(our: OurSide | null, van: VanSide | null): VanMismatchKind | null {
  const inService = our?.status === TerminalStatus.IN_SERVICE;
  if (inService) {
    if (!van || van.status === VanStatus.CANCELLED) return VanMismatchKind.NOT_REGISTERED;
    if (van.status === VanStatus.SUSPENDED) return VanMismatchKind.SUSPENDED_WHILE_IN_SERVICE;
    return our!.merchantCode !== null && serialKey(our!.merchantCode) === serialKey(van.merchantCode) ? null : VanMismatchKind.MERCHANT_MISMATCH;
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
