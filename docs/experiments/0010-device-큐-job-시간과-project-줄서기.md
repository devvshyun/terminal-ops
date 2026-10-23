# 0010. device 큐 job(오프라인 판정·스냅샷) 시간 — project job이 뒤에 줄서는 시간

- 날짜 / 관련 기능: 2026-10-23 / F8 (Day 4 Task 5, Task 4 리뷰 Minor: concurrency 1의 head-of-line)
- 번호: 0008·0009는 계획이 Task 9·10 실험에 예약했으므로 이 실험은 0010을 쓴다(계획에 없던 측정).
- 질문: device 큐는 concurrency 1이라 판정(detect-offline)·스냅샷(snapshot)이 도는 동안 active 갱신(project) job이 기다린다. 단말기 수천 대에서 이 job들이 얼마나 걸리나? project가 밀리는 것이 걱정할 만한가?
- 설정
  - 운영 중(IN_SERVICE) 단말기 N=5,000(`em.insertMany`로 바로 넣음), active 재구성 후 시작. 오프라인 기준 90초
  - 서비스 직접 호출(`ConnectivityService.detect(now, 90000)`, `snapshot()`, `ActiveSetService.apply([1대])`), 큐·워커 없이 함수 시간만(`performance.now()`)
  - 회차마다 Redis(lastSeen·firmware·offline·snapshotAt)와 `device_connectivity`·`outbox_event`를 비우고 ① → ⑤ 순서로 잰다
    - ① 평소: 5,000대 모두 1초 전 하트비트 → detect(바뀐 것 없음)
    - ② snapshot: 5,000대 모두 바뀜(첫 스냅샷, UPSERT 500행 × 10문장)
    - ③ 대량 끊김: 5,000대 모두 120초 전 → detect(UPSERT 5,000행 + Outbox 5,000행 한 트랜잭션)
    - ④ 이미 모두 오프라인으로 기록된 뒤 detect(SMEMBERS 5,000, 바뀐 것 없음)
    - ⑤ 대량 복귀: 5,000대 모두 새 하트비트 → detect(UPSERT + Outbox 5,000행)
    - 비교: project job 하나(apply 1대)
  - 로컬 한 PC(Windows 11), Docker MySQL 8.4·Redis 7.4, 테스트 DB `terminal_ops_test`, 테스트 접두사 키만
  - 테스트 파일: `apps/api/test/experiments/device-jobs-timing.spec.ts`(EXPERIMENTS=1일 때만)
- 재현 (`apps/api`에서):
  ```bash
  EXPERIMENTS=1 N=5000 npx vitest run test/experiments/device-jobs-timing.spec.ts --silent=false 2>&1 | grep -E "^\||실험 0010|Tests "
  ```

## 결과 — 1회 실행 × 3회차, `Tests 1 passed (1)` (단위 ms)

```
[실험 0010] N=5000
| 회차 | ① detect 평소(변화 0) | ② snapshot 전체 | ③ detect 대량 끊김 | ④ detect 이미 오프라인 | ⑤ detect 대량 복귀 | project 1대 |
|---|---|---|---|---|---|---|
| 1 | 2 | 552.1 | 1506 | 15.7 | 1387.9 | 2.4 |
| 2 | 1.8 | 496.4 | 1359.1 | 12.4 | 1348.2 | 1.5 |
| 3 | 1.6 | 491.9 | 1347.5 | 11 | 1335.4 | 1.7 |
```

## 추가 측정 (fix 커밋, 같은 날) — relay 줄: 대량 끊김이 남긴 Outbox 행을 relay가 다 옮기는 데 몇 번 걸리나

- 질문: 위 결론은 device 큐 안의 줄서기만 봤다. 대량 끊김 판정이 Outbox에 남긴 행은 relay가 2초마다 100행씩 옮긴다. 그 뒤에 쓰인 행(`terminal.status_changed` 알림, 그리고 relay가 넣는 project job)은 이 줄이 빠질 때까지 기다린다. 이 줄이 얼마나 긴가?
- 설정 추가: ③ 직후 `outbox_event`의 PENDING 행 수를 세고, `OutboxService.relay(100)`를 잡은 행이 0이 될 때까지 바로바로 불러 횟수와 함수 시간 합을 잰다. 운영에서는 relay가 2초(`RELAY_INTERVAL_MS`)마다 한 번이므로 "줄 예상(초)" = 횟수 × 2초다. 워커는 꺼져 있어 notify job은 큐에 쌓이기만 한다(메신저 호출 없음).
- 묶음 기준: `CONNECTIVITY_BULK_EVENT_THRESHOLD` 기본 50(fix 뒤에만 의미 있음).
- 재현: 위와 같은 명령(표에 열 4개가 늘었다).

### fix 전(단말기별 Outbox 행) — `Tests 1 passed (1)`, 단위 ms

```
[실험 0010] N=5000
| 회차 | ① detect 평소(변화 0) | ② snapshot 전체 | ③ detect 대량 끊김 | ④ detect 이미 오프라인 | ⑤ detect 대량 복귀 | project 1대 | ③ Outbox 행 | relay 횟수(100행) | relay 줄 예상(초, ×2초) | relay 함수 시간 합 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2.4 | 553 | 1534.9 | 14.5 | 1423.5 | 3 | 5000 | 50 | 100 | 678.6 |
| 2 | 1.8 | 515.3 | 1425.3 | 14.2 | 1403.3 | 1.8 | 5000 | 50 | 100 | 649 |
| 3 | 1.9 | 508 | 1422.1 | 15.1 | 1407.1 | 1.7 | 5000 | 50 | 100 | 825.7 |
```

### fix 뒤(기준 50대를 넘으면 묶음 한 행) — `Tests 1 passed (1)`, 단위 ms

```
[실험 0010] N=5000
| 회차 | ① detect 평소(변화 0) | ② snapshot 전체 | ③ detect 대량 끊김 | ④ detect 이미 오프라인 | ⑤ detect 대량 복귀 | project 1대 | ③ Outbox 행 | relay 횟수(100행) | relay 줄 예상(초, ×2초) | relay 함수 시간 합 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2.3 | 561.3 | 558.9 | 17.5 | 583.5 | 2.7 | 1 | 1 | 2 | 13.7 |
| 2 | 1.7 | 501.3 | 556 | 13.2 | 564.2 | 1.9 | 1 | 1 | 2 | 9.1 |
| 3 | 1.7 | 497.2 | 552.5 | 13.6 | 560 | 1.9 | 1 | 1 | 2 | 10.4 |
```

## 결론

- 평소 판정(①)은 2ms 안팎이다. ZRANGEBYSCORE가 빈 결과를 주고 오프라인 SET도 비어 MySQL을 치지 않는다.
- 무거운 경우는 둘이다. 스냅샷 전체(②, 약 0.5초)와 대량 끊김·복귀(③⑤, 약 1.3~1.5초).
  - 하트비트 주기(30초)가 스냅샷 주기(60초)보다 짧아서 운영 중에는 매 스냅샷이 거의 전부를 다시 쓴다. 즉 ②는 1분마다 한 번씩 생긴다.
  - ③⑤는 큰 장애(망 단절 등)가 났다 풀릴 때만 생긴다.
- project job이 그 뒤에 줄서는 시간: 평소에는 1분에 한 번 최대 약 0.5초, 대량 끊김·복귀 때는 최대 약 1.5초다. project 반영 지연에 이미 relay 주기(2초)가 들어 있으니, 5,000대에서는 **걱정할 정도가 아니라고 본다**. 큐를 나누지 않는다.
  - 다만 ③의 1.5초 동안 5,000대는 어차피 오프라인이다. 그 사이 IN_SERVICE 진입·이탈 반영이 1.5초 늦어도 영향이 작다.
- **(정정, fix 커밋)** 위 판단은 device 큐만 보고 내린 것이라 틀렸다. 더 큰 지연은 relay 줄이었다. fix 전 대량 끊김 한 번이 Outbox 5,000행을 남겨 relay 50번, 2초 주기로 약 **100초** 줄이 생겼다(relay 함수 시간 자체는 합 0.65~0.83초라, 줄의 거의 전부가 주기 대기다). 그동안 그 뒤의 상태 변경 알림과 project job이 밀린다. 대량 복귀(⑤)도 같은 양을 한 번 더 만든다. device 큐 줄서기(최대 약 1.5초)보다 두 자릿수 크다.
  - fix 뒤(묶음 한 행): Outbox 1행, relay 1번(줄 예상 2초 이하). 판정 함수 시간도 ③ 1,422~1,535ms → 553~559ms, ⑤ 1,403~1,424ms → 560~584ms로 줄었다(Outbox 5,000행 INSERT가 빠짐).
  - ①②④와 project 1대는 fix 전후 같은 범위다(바뀐 코드가 그 경로를 지나지 않음).
- 다시 볼 조건(decisions/0028·0029): 단말기가 수만 대가 되어 ②가 수 초가 될 때(스냅샷 증분·큐 나누기), Task 7의 배포 판단 job이 길어질 때.
- 한계
  - ③⑤에서 시간이 어디에 쓰였는지(Outbox 5,000행 INSERT, UPSERT 10문장, Redis)는 나눠 재지 않았다.
  - 함수 시간만 쟀다. 큐에서 job을 꺼내는 시간과 워커 여럿일 때는 재지 않았다.
  - 한 번 실행(3회차)이다.
  - relay 줄은 함수를 바로바로 불러 횟수만 쟀고, 실제 주기(2초)를 기다려 끝까지 잰 것은 아니다. "100초"는 50번 × 2초로 계산한 값이다. notify 워커가 메신저로 보내는 시간(알림 5,000건 자체)은 재지 않았다.
