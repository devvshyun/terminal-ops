export enum TerminalStatus {
  RECEIVED = 'RECEIVED', // 입고
  INSPECTED = 'INSPECTED', // 검수 합격
  DEFECTIVE = 'DEFECTIVE', // 불량
  IN_STOCK = 'IN_STOCK', // 재고
  ALLOCATED = 'ALLOCATED', // 가맹점 배정
  SHIPPED = 'SHIPPED', // 출고(배송 중)
  DELIVERED = 'DELIVERED', // 배송 완료
  IN_SERVICE = 'IN_SERVICE', // 운영 중
  RETURN_REQUESTED = 'RETURN_REQUESTED', // 회수 요청
  RETURNING = 'RETURNING', // 회수 중
  RETURNED = 'RETURNED', // 회수 입고
  DISPOSED = 'DISPOSED', // 폐기
}

/** 상태를 바꾼 경로. 규칙별 허용 출처는 transition-rules.ts에서 정한다(decisions/0007). */
export enum TransitionSource {
  MANUAL = 'MANUAL',
  INSPECTION = 'INSPECTION',
  BATCH = 'BATCH', // 시스템 배치(택배 추적 수집 등)
}
