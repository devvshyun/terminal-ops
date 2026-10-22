# Day 2 최종 리뷰 요약 (2026-10-22)

- 범위: `c9658f4..0a34502` (day2-carrier-sync, 커밋 17개)
- 검증: api 16파일 114 passed, partners 32 passed, typecheck·build 0, migration check 최신 상태, 남은 worker/partners 프로세스 0, 추적되는 비밀값 없음
- 새 마이그레이션 4개(BATCH enum, merchant, shipment/sync_run/carrier_event, outbox_event)
- 판정: master 병합 가능 (Critical·Important 없음)

## Minor (Day 3 이후)
1. `applyDelivered`가 운송장이 단말기의 **현재** 운송장인지 확인하지 않는다. 운송장이 여러 장이면 옛 운송장의 DELIVERED가 새 출고를 완료 처리할 수 있다. Day 3 F7(교체 출고)부터 실제로 생기므로 그때 함께 막는다(최근 IN_TRANSIT 운송장만 반영, 또는 재출고 시 이전 운송장 SUPERSEDED).
2. job scheduler는 Redis에 남는다. 모든 프로세스를 `RUN_SCHEDULERS=0`으로 띄워도 예전 주기로 계속 돈다(개발 Redis에 1000ms 주기 2개 잔존). `scheduler:clear` 스크립트 또는 decisions/0015 한계에 기록.
3. relay가 행 락을 쥔 채 Redis `add`를 최대 100번 → `addBulk` 검토(F6 대량 등록 때).
4. Retry-After 상한 없음(예: 60s 상한), 429도 attempts를 소모.
5. two-workers 실험의 "worker ready" 감지가 stdout 청크 경계에 취약 → 누적 검사.
6. 테스트 로그 `MaxListenersExceededWarning` 원인 미확인(추정: supertest가 요청마다 listen).
7. `Migration20261022053251.down()`은 BATCH 행이 있으면 strict 모드에서 실패 → 주석/트러블슈팅에 한 줄.
8. 출고 시 오래된 identity map으로 낙관적 락 확인 → flush version 검사가 막아 안전하지만 409와 함께 고아 운송장 1건(decisions/0012 범위).

## Day 3 준비
- F7(A/S·교체 출고): 일반 전이 API 우회 차단(ALLOCATED·SHIPPED 전용 출처), 배정 취소 시 merchant 비우기(`mutate`), 위 Minor 1을 같은 작업에서.
- F6(박스 일괄 스캔 + 엑셀 일괄 등록): `recordRegistration` 경유(이력·outbox), outbox relay 부하(addBulk), 대량 flush·N+1, 부분 실패 정책을 결정 기록으로.
- F10(발주 대 입고 대조): F6 다음 순서(입고 경로 공유).
- 이월: 1213 HTTP 매핑, QUEUED 복구 sweep(Day 7), 영구 실패 운송장 제외 상태, 개발 Redis scheduler 정리, Day 1 리뷰 Minor 2·4·5·6·7.
