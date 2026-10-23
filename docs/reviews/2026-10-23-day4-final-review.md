# Day 4 최종 리뷰 요약 (2026-10-23)

- 범위: `1684872..ac9e2df` (day4-devices)
- 검증: api 40파일 268 passed, device-sim 40, partners 40, typecheck·build 0, migration check 최신 상태, 남은 node 프로세스 0, 작업 트리 깨끗
- 판정: 1차 리뷰 "수정 후 병합" → ac9e2df(이미 목표 버전인 대상의 거짓 자동 중단 수정, Lua pcall, finish(now), devlog 시각 5곳 정정) 재리뷰 승인 → 병합
- 병합 전 반영: devlog 마지막 항목 제목 21:35 → 21:34(커밋 시각)

## 남은 Minor (Day 5 이후)
- 같은 버전 재배포 시 이미 목표 버전인 대상은 단계 제한 시간이 지나야 성공으로 세진다(단계마다 제한 시간만큼 지연).
- 하트비트가 보낸 버전을 그대로 믿는다(단말기 인증 없음, decisions/0001과 같은 전제).
- `firmware_rollout_target_rollout_id_index` 중복 인덱스(Day 5 실행계획 기록 때).
- 새 env 주기값 NaN 검사 없음.

## Day 5 준비
- F9 브릿지VAN: partners에 아직 없음. 등록 단말기 목록 API(페이지, 커서 vs offset, 페이지 중간 변경, 시드 어긋남 비율). 대조 키(serial_no + 가맹점 코드) 먼저 결정. terminal에 VAN 등록 필드 없음.
- F4 이상 단말기 찾기: `terminal_status_history (terminal_id, occurred_at)` 활용 vs `terminal (status, updated_at)` 복합 인덱스를 실행계획으로 비교. updated_at은 다른 수정에도 바뀜 주의.
- F11 주간 리포트: exceljs 이미 있음. 톡톡메신저 가상 API에 첨부 방식 정하기.
- 새 주기 작업은 `JOB_SCHEDULERS`에 추가하되 device 큐(concurrency 1)에 무거운 집계를 넣지 말고 큐를 나눈다(experiments/0010).
- 개발 DB에 SN-300 운영 중 단말기와 배포 #1·#2, 개발 Redis에 하트비트 키가 남아 있다.
