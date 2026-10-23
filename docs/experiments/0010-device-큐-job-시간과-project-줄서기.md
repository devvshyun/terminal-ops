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

## 결론

- 평소 판정(①)은 2ms 안팎이다. ZRANGEBYSCORE가 빈 결과를 주고 오프라인 SET도 비어 MySQL을 치지 않는다.
- 무거운 경우는 둘이다. 스냅샷 전체(②, 약 0.5초)와 대량 끊김·복귀(③⑤, 약 1.3~1.5초).
  - 하트비트 주기(30초)가 스냅샷 주기(60초)보다 짧아서 운영 중에는 매 스냅샷이 거의 전부를 다시 쓴다. 즉 ②는 1분마다 한 번씩 생긴다.
  - ③⑤는 큰 장애(망 단절 등)가 났다 풀릴 때만 생긴다.
- project job이 그 뒤에 줄서는 시간: 평소에는 1분에 한 번 최대 약 0.5초, 대량 끊김·복귀 때는 최대 약 1.5초다. project 반영 지연에 이미 relay 주기(2초)가 들어 있으니, 5,000대에서는 **걱정할 정도가 아니라고 본다**. 큐를 나누지 않는다.
  - 다만 ③의 1.5초 동안 5,000대는 어차피 오프라인이다. 그 사이 IN_SERVICE 진입·이탈 반영이 1.5초 늦어도 영향이 작다.
- 다시 볼 조건(decisions/0028·0029): 단말기가 수만 대가 되어 ②가 수 초가 될 때(스냅샷 증분·큐 나누기), Task 7의 배포 판단 job이 길어질 때.
- 한계
  - ③⑤에서 시간이 어디에 쓰였는지(Outbox 5,000행 INSERT, UPSERT 10문장, Redis)는 나눠 재지 않았다.
  - 함수 시간만 쟀다. 큐에서 job을 꺼내는 시간과 워커 여럿일 때는 재지 않았다.
  - 한 번 실행(3회차)이다.
