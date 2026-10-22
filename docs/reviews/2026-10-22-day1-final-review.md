# Day 1 최종 리뷰 요약 (2026-10-22)

- 범위: `03a9b98..48f88cb` (day1-terminal-core, 커밋 11개)
- 검증: vitest 56 passed, typecheck 0, build 0, migration check 최신 상태, 추적되는 비밀값 없음
- 판정: master 병합 가능

## Important (Day 2 첫 커밋 또는 Day 3 IMPORT 전에)
1. `TerminalService.register`가 첫 이력(null → RECEIVED)을 직접 만든다. "상태 변경은 TransitionService 한 곳" 원칙의 예외인데 문서화돼 있지 않다. → `TransitionService`에 등록 이력 기록 메서드를 두어 일원화(권장)하거나, 최소한 예외임을 결정 기록에 남긴다.

## Minor
2. 검수 불합격 사유(`검수 불합격: A, B, ...`)가 항목이 많으면 `reason varchar(200)`을 넘길 수 있다(현재 시드는 최대 4개라 안전).
3. `TransitionDto.reason`이 공백만 있는 문자열을 통과시킨다.
4. 테스트의 `MaxListenersExceededWarning`은 supertest가 listen하지 않은 서버에 동시 요청을 보낼 때 나는 소음.
5. 중복 인덱스: `terminal_status_history(terminal_id)` vs `(terminal_id, occurred_at)`, `inspection_item(model_id)` vs unique `(model_id, code)`.
6. `inspect`가 단말기를 두 번 SELECT한다(serialNo는 PK가 아니라 identity map을 타지 않음).
7. 저장소를 공개한다면: compose 포트를 `127.0.0.1`에만 바인드, `.env.example`은 placeholder로.

## 기록 표현 정정 거리
- devlog·1일차 요약의 "계획 순서가 매번 {201:1,500:9}" → 숫자를 기록한 것은 3회.
- 요약의 "둘 다 근거를 확인한 뒤 고쳤다" → 두 번째(검수)는 순서를 먼저 바꾸고, 계획 순서로 재현해 확인했다.
- decisions/0006 "수정 후 3회" → experiments/0002 기준 6회.

## Day 2 준비 사항
1. `TransitionSource.BATCH` 추가 시 decisions/0003 주의 사항 적용: 기본 허용 출처를 `[MANUAL]`로 좁히고 배송 전이에만 `[MANUAL, BATCH]`. 네이티브 enum이라 ALTER 마이그레이션을 같은 커밋에.
2. BullMQ 워커에는 RequestContext가 없다 → 잡마다 `em.fork()`를 넘기거나 `@CreateRequestContext()`.
3. 이미 목표 상태인 단말기에 같은 배송 이벤트가 다시 오면 InvalidTransition이 난다 → no-op 처리 여부를 결정 기록으로.
4. 재시도 분류: OptimisticLock·데드락(1213) → 재시도 / InvalidTransition → 실패 또는 no-op.
5. 워커 actor는 `system:<작업명>`.
6. experiments/0001 한계에 적은 "워커 2개 실험"을 Day 2에서.
