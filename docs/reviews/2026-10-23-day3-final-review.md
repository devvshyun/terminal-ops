# Day 3 최종 리뷰 요약 (2026-10-23)

- 범위: `90c3501..2e8ef44` (day3-ops-workflows, 커밋 21개)
- 검증: api 29파일 200 passed(2회), partners 40 passed, typecheck·build 0, migration check 최신 상태, 실험 0007 재실행 수치 일치, 남은 node 프로세스 0, 작업 트리 깨끗, 추적되는 비밀값 없음
- 판정: master 병합 가능 (Critical·Important 없음)
- 병합 전 반영: `.env.example`에 `SCAN_LOCK_TTL_MS` 추가(Minor 3)

## Minor (Day 4 첫 작업에서)
1. 같은 교체 단말기 경합 시 고아 운송장 N-1장(실험 0007) → 운송장 발급 전에 교체 단말기 시리얼로 Redis 예약 잠금(ScanLock 패턴). 공용 Redis 공급자와 함께.
2. `scan-lock.ts`의 전용 ioredis 연결에 error 리스너 없음, 테스트 첫 실행에서 출처 불명 `Connection is closed` 1회 → 공용 Redis 공급자로 모으고 error 리스너·종료 순서 정리.
4. 설치 확인에서 REPLACING이 아닐 때도 `TICKET_NOT_OPEN` → `TICKET_NOT_REPLACING` 등으로 분리.
5. 테이블 collate 지정이 마이그레이션마다 다름(purchase_order·scan_batch는 서버 기본값 의존) → decisions/0025에 한 줄.
6. devlog 3일차 요약·experiments/0006의 "3회 범위" 기준이 항목마다 섞임(A는 보강 5회 포함) → 기준 표시.
7. 테스트 로그 잡음(MaxListenersExceededWarning, 간헐 ioredis 종료 오류).

## Day 4 준비
- 하트비트는 lifecycle 전이가 아니다: TransitionService·이력·Outbox를 거치지 않는 파생 상태(Redis lastSeen ZSET + 주기 스냅샷)로 먼저 결정 기록.
- 펌웨어 배포는 단말기 상태 enum을 건드리지 않는 별도 테이블(`firmware_rollout`, `firmware_result`) → enum 마이그레이션 회피.
- 하트비트 키는 `env.queuePrefix` 접두사로 테스트·개발 분리, 정리는 접두사 SCAN+DEL(FLUSH 금지).
- 공용 Redis 공급자 모듈(ScanLock과 공유, error 리스너, onModuleDestroy quit).
- 오프라인 판정·단계 승격은 기존 job scheduler 패턴 재사용, 자동 중단은 롤아웃 행 FOR UPDATE.
- device-sim은 partners처럼 globalSetup에서 띄우고 PID로만 종료, 5,000대 실험은 keep-alive·동시성 상한(Windows 임시 포트 고갈 주의), 배치 하트비트 엔드포인트도 비교.
- 실험은 "Redis 없이 MySQL 직접 쓰기"와 MySQL 쓰기 횟수·lock_deadlocks 비교.
