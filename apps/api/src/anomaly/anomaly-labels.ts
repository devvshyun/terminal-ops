import { AnomalyRule } from './anomaly.entity.js';

/**
 * 알림·리포트·화면에 쓰는 규칙 이름(규칙 순서). 상수만 두는 파일이다 — outbox·report가 이것 때문에 규칙 모듈(env·쿼리)을
 * 불러오지 않게 anomaly-rules.ts에서 떼어 냈다(Day 5 최종 리뷰 Minor 5, decisions/0037).
 */
export const ANOMALY_RULE_LABEL: Record<AnomalyRule, string> = {
  [AnomalyRule.DELIVERED_NOT_INSTALLED]: '배송 완료 후 미설치',
  [AnomalyRule.RETURN_STALLED]: '회수 지연',
  [AnomalyRule.SHIPPED_TOO_LONG]: '배송 지연',
  [AnomalyRule.ALLOCATED_NO_SHIPMENT]: '배정 후 미출고',
  [AnomalyRule.IN_SERVICE_NO_MERCHANT]: '운영 중 가맹점 없음',
  [AnomalyRule.OFFLINE_TOO_LONG]: '장기 오프라인',
};
