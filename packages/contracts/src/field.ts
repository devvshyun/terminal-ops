/**
 * 현장 작업자 화면(보강 4, `apps/field`)이 받는 모양. 박스 스캔·검수 자체는 운영자 어드민과 같은 API(`POST /scans`,
 * `POST /terminals/:serialNo/inspections`)를 쓰고, 여기에는 현장 화면에만 있는 "오늘 내 작업" 요약만 있다(decisions/0063).
 */

/** GET /field/today — 로그인한 현장 작업자가 오늘(KST 0시부터) 한 일 */
export interface FieldTodayView {
  /** 오늘 KST 날짜 'YYYY-MM-DD' */
  date: string;
  scans: {
    /** 처리한 박스 수(같은 scanId로 다시 보낸 것은 한 번 — decisions/0020) */
    boxes: number;
    /** 발주분 입고로 등록된 단말기 수(행 결과 CREATED) */
    received: number;
    /** 회수 입고된 단말기 수(행 결과 RETURNED) */
    returned: number;
    /**
     * 저장된 박스의 행 결과 중 거절된 줄 수(형식·중복·명세 밖·상태 등 — CREATED·RETURNED가 아닌 것).
     * 요청 전체가 거절돼 박스로 저장되지 않은 경우(마감된 발주 PO_CLOSED, 400 형식 오류, 다른 내용의 같은 scanId 등)는 세지 않는다 — 화면 문구는 "거절된 줄".
     */
    rejected: number;
  };
  inspections: {
    total: number;
    passed: number;
    failed: number;
  };
}
