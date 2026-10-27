# 0016. 상태 조건 단말기 목록의 (status, id) 인덱스 — 계획, 읽은 행, 시간, 쓰기 비용

- 날짜 / 관련 기능: 2026-10-27 / F1(단말기 목록 상태 조건) (Day 7 Task 7, decisions/0039·0034·0045, 실험 0013)
- 질문:
  1. `where status = ? order by id desc limit 20`이 흔한 상태·드문 상태에서 각각 어떤 계획으로 몇 행을 읽나?
  2. `(status, id)` 인덱스가 있으면 계획·시간이 바뀌나?
  3. 그 인덱스의 쓰기 비용(상태 UPDATE·INSERT 한 건씩)과 크기는?
- 채택 기준(실험 전에 계획에 정해 둔 것): 어느 상태든 목록 p50이 2배 이상 그리고 1ms 이상 줄면 채택. 한 건 UPDATE 비용이 +10%를 넘으면 그것만으로도 채택하지 않음
- 설정
  - 시드: `apps/api/test/helpers/fleet-seed.ts`(실험 0011 분포) 단말기 100,000, 이력 999,979. 거기에 `update terminal set status = 'DEFECTIVE' where id % 200 = 0`, `'DISPOSED' where id % 2000 = 0`으로 드문 상태를 id 전체에 흩음. 시드 6.9초
  - 서비스 `TerminalService.list({ status, page: 1, size: 20 }, SELECT_IN)` RUNS 20(데우기 1회 뒤), 목록·count SQL마다 `EXPLAIN ANALYZE`
  - 쓰기: 1,000건씩 3회, 변형(없음/있음) 순서를 회차마다 바꿈, 회차·변형마다 상태를 뒤집음(`pass++ % 2` — 같은 값이면 no-op이 된다). 인덱스는 `alter table terminal add/drop index exp16_status_id (status, id)`로 실험 중에만
  - MySQL 8.4(innodb_buffer_pool_size 128MB), Node v24, 로컬 한 PC(Windows 11, Docker), 테스트 DB `terminal_ops_test`
  - 테스트 파일: `apps/api/test/experiments/status-index.spec.ts`(EXPERIMENTS=1일 때만). `afterAll`이 실험 인덱스를 지우고 `resetDatabase`로 테스트 DB를 다시 만든다
- 재현 (`apps/api`에서, 다른 api vitest가 돌지 않을 때):
  ```bash
  EXPERIMENTS=1 npx vitest run test/experiments/status-index.spec.ts --silent=false > exp16.log 2>&1
  grep -E "\[실험 0016|^  인덱스|목록:|count:|Tests " exp16.log
  ```
  1번 돌렸다(로그 `Start at 17:54:07`, 17:54:59 끝, `Tests 2 passed (2)`, Duration 51.88s).

## 결과

원문(`explain analyze` 출력은 테스트가 400·250자에서 자른 것 그대로, `exp16.log`에서 grep):

```
[실험 0016] 시드 {"ms":6940,"terminals":100000,"history":999979,"connectivity":9569,"anomalies":5000} 상태별 RETURNED 10477, IN_STOCK 10476, ALLOCATED 10475, DELIVERED 10475, IN_SERVICE 10475, INSPECTED 10473, RETURNING 10473, SHIPPED 10470, RETURN_REQUESTED 10470, RECEIVED 5236, DEFECTIVE 450, DISPOSED 50
[실험 0016 ①]
  인덱스 없음 IN_SERVICE: p50 2.89ms p95 3.47ms
    목록: -> Limit: 20 row(s) (cost=0.312 rows=19.9) (actual time=0.0994..0.142 rows=20 loops=1) -> Filter: (t0.`status` = 'IN_SERVICE') (cost=0.312 rows=19.9) (actual time=0.069..0.111 rows=20 loops=1) -> Index scan on t0 using PRIMARY (reverse) (cost=0.312 rows=99) (actual time=0.00817..0.0431 rows=175 loops=1) 
    count: -> Aggregate: count(0) (cost=4022 rows=1) (actual time=2.23..2.23 rows=1 loops=1) -> Filter: (t0.`status` = 'IN_SERVICE') (cost=2015 rows=20070) (actual time=0.0689..1.92 rows=10475 loops=1) -> Covering index lookup on t0 using terminal_status_status
  인덱스 없음 RECEIVED: p50 1.91ms p95 2.09ms
    목록: -> Limit: 20 row(s) (cost=1.2 rows=20) (actual time=0.0123..0.101 rows=20 loops=1) -> Filter: (t0.`status` = 'RECEIVED') (cost=1.2 rows=20) (actual time=0.012..0.1 rows=20 loops=1) -> Index scan on t0 using PRIMARY (reverse) (cost=1.2 rows=381) (actual time=0.00922..0.0835 rows=396 loops=1) 
    count: -> Aggregate: count(0) (cost=1049 rows=1) (actual time=0.876..0.876 rows=1 loops=1) -> Filter: (t0.`status` = 'RECEIVED') (cost=526 rows=5236) (actual time=0.0273..0.761 rows=5236 loops=1) -> Covering index lookup on t0 using terminal_status_status_c
  인덱스 없음 DEFECTIVE: p50 2.86ms p95 3ms
    목록: -> Limit: 20 row(s) (cost=158 rows=20) (actual time=0.404..0.406 rows=20 loops=1) -> Sort: t0.id DESC, limit input to 20 row(s) per chunk (cost=158 rows=450) (actual time=0.385..0.386 rows=20 loops=1) -> Index lookup on t0 using terminal_status_status_changed_at_index (status='DEFECTIVE'), with index condition: (t0.`status` = 'DEFECTIVE') (cost=158 rows=450) (actual time=0.0433..0.348 rows=450 loo
    count: -> Aggregate: count(0) (cost=90.4 rows=1) (actual time=0.0839..0.0839 rows=1 loops=1) -> Filter: (t0.`status` = 'DEFECTIVE') (cost=45.4 rows=450) (actual time=0.00657..0.0731 rows=450 loops=1) -> Covering index lookup on t0 using terminal_status_stat
  인덱스 없음 DISPOSED: p50 2.41ms p95 4.54ms
    목록: -> Limit: 20 row(s) (cost=17.5 rows=20) (actual time=0.0596..0.0613 rows=20 loops=1) -> Sort: t0.id DESC, limit input to 20 row(s) per chunk (cost=17.5 rows=50) (actual time=0.0592..0.0602 rows=20 loops=1) -> Index lookup on t0 using terminal_status_status_changed_at_index (status='DISPOSED'), with index condition: (t0.`status` = 'DISPOSED') (cost=17.5 rows=50) (actual time=0.0282..0.0507 rows=50 
    count: -> Aggregate: count(0) (cost=10.3 rows=1) (actual time=0.0199..0.0199 rows=1 loops=1) -> Filter: (t0.`status` = 'DISPOSED') (cost=5.27 rows=50) (actual time=0.00572..0.0176 rows=50 loops=1) -> Covering index lookup on t0 using terminal_status_status_
  인덱스 있음 IN_SERVICE: p50 2.84ms p95 3.22ms
    목록: -> Limit: 20 row(s) (cost=1360 rows=20) (actual time=0.543..0.548 rows=20 loops=1) -> Filter: (t0.`status` = 'IN_SERVICE') (cost=1360 rows=10475) (actual time=0.542..0.546 rows=20 loops=1) -> Index lookup on t0 using exp16_status_id (status='IN_SERVICE') (reverse) (cost=1360 rows=10475) (actual time=0.515..0.517 rows=20 loops=1) 
    count: -> Aggregate: count(0) (cost=2107 rows=1) (actual time=2.22..2.22 rows=1 loops=1) -> Filter: (t0.`status` = 'IN_SERVICE') (cost=1060 rows=10475) (actual time=0.0397..1.94 rows=10475 loops=1) -> Covering index lookup on t0 using exp16_status_id (statu
  인덱스 있음 RECEIVED: p50 1.73ms p95 1.86ms
    목록: -> Limit: 20 row(s) (cost=1.2 rows=20) (actual time=0.0127..0.104 rows=20 loops=1) -> Filter: (t0.`status` = 'RECEIVED') (cost=1.2 rows=20) (actual time=0.0124..0.103 rows=20 loops=1) -> Index scan on t0 using PRIMARY (reverse) (cost=1.2 rows=381) (actual time=0.0097..0.086 rows=396 loops=1) 
    count: -> Aggregate: count(0) (cost=1049 rows=1) (actual time=0.893..0.893 rows=1 loops=1) -> Filter: (t0.`status` = 'RECEIVED') (cost=526 rows=5236) (actual time=0.0226..0.776 rows=5236 loops=1) -> Covering index lookup on t0 using terminal_status_status_c
  인덱스 있음 DEFECTIVE: p50 2.63ms p95 4.22ms
    목록: -> Limit: 20 row(s) (cost=158 rows=20) (actual time=0.391..0.393 rows=20 loops=1) -> Sort: t0.id DESC, limit input to 20 row(s) per chunk (cost=158 rows=450) (actual time=0.391..0.392 rows=20 loops=1) -> Index lookup on t0 using terminal_status_status_changed_at_index (status='DEFECTIVE'), with index condition: (t0.`status` = 'DEFECTIVE') (cost=158 rows=450) (actual time=0.0418..0.354 rows=450 loo
    count: -> Aggregate: count(0) (cost=90.4 rows=1) (actual time=0.0796..0.0796 rows=1 loops=1) -> Filter: (t0.`status` = 'DEFECTIVE') (cost=45.4 rows=450) (actual time=0.00464..0.0691 rows=450 loops=1) -> Covering index lookup on t0 using terminal_status_stat
  인덱스 있음 DISPOSED: p50 2.14ms p95 2.42ms
    목록: -> Limit: 20 row(s) (cost=17.5 rows=20) (actual time=0.0571..0.059 rows=20 loops=1) -> Sort: t0.id DESC, limit input to 20 row(s) per chunk (cost=17.5 rows=50) (actual time=0.0569..0.0581 rows=20 loops=1) -> Index lookup on t0 using terminal_status_status_changed_at_index (status='DISPOSED'), with index condition: (t0.`status` = 'DISPOSED') (cost=17.5 rows=50) (actual time=0.0265..0.049 rows=50 lo
    count: -> Aggregate: count(0) (cost=10.3 rows=1) (actual time=0.0165..0.0165 rows=1 loops=1) -> Filter: (t0.`status` = 'DISPOSED') (cost=5.27 rows=50) (actual time=0.00556..0.0145 rows=50 loops=1) -> Covering index lookup on t0 using terminal_status_status_
[실험 0016 ②] 1000건씩 3회(ms): UPDATE 없음 2829/3011/3107 있음 3187/3191/3115 / INSERT 없음 3085/2942/2933 있음 3082/3084/3164 / 보조 인덱스 terminal 없음 14.56MB 있음 16.02MB
```

요약 표(목록 1쪽):

| 상태 | 대수 | 인덱스 없음: 계획·읽은 행·p50/p95 | 인덱스 있음: 계획·p50/p95 |
|---|---|---|---|
| IN_SERVICE | 10,475 | PRIMARY 역순 175행 → 20행, 2.89 / 3.47ms | `exp16_status_id` 역순 룩업 20행(actual 0.515..0.517), 2.84 / 3.22ms |
| RECEIVED | 5,236 | PRIMARY 역순 396행 → 20행, 1.91 / 2.09ms | 같은 계획(PRIMARY 역순 396행), 1.73 / 1.86ms |
| DEFECTIVE | 450 | `(status, status_changed_at)` 룩업 450행 → 정렬 limit 20, 2.86 / 3.0ms | 같은 계획, 2.63 / 4.22ms |
| DISPOSED | 50 | `(status, status_changed_at)` 룩업 50행 → 정렬 limit 20, 2.41 / 4.54ms | 같은 계획, 2.14 / 2.42ms |

쓰기 비용(1,000건씩 3회 합계, ms): UPDATE 없음 2829/3011/3107(평균 2982) 있음 3187/3191/3115(평균 3164, +6.1%), INSERT 없음 3085/2942/2933(평균 2987) 있음 3082/3084/3164(평균 3110, +4.1%), 보조 인덱스 합계 14.56MB → 16.02MB(+1.46MB).

## 결론

- 기존 `(status, status_changed_at)` 인덱스가 드문 상태를 이미 맡는다. 옵티마이저가 그 인덱스로 450·50행을 찾고 20행만 정렬했다 — decisions/0039가 걱정한 "드문 상태에서 PK 역순으로 많이 읽기"는 이 분포(450·50대)에서 일어나지 않았다. 흔한 상태(약 1만·5천 대)는 PK 역순으로 175·396행에서 20행을 채우고 멈춘다.
- `(status, id)`가 있을 때 계획이 바뀐 것은 IN_SERVICE 하나(PK 역순 175행 → 새 인덱스 20행)뿐이다. 시간은 2.89 → 2.84ms로 차이가 없다. 나머지 셋은 계획도 같고 시간 차이는 측정 흔들림 안(p50 0.2~0.3ms)이다. 사전에 정한 기준(p50 2배 이상 그리고 1ms 이상 감소)에 어느 상태도 해당하지 않는다.
- 쓰기 비용은 UPDATE +6.1%, INSERT +4.1%(평균 기준, 회차 사이 흔들림이 100~300ms로 이 차이와 같은 자릿수), 인덱스 크기 +1.46MB. UPDATE +10% 기준은 넘지 않았다. 채택 판단은 위 첫 기준 하나로 충분히 나온다.
- 채택하지 않는다(decisions/0045). 마이그레이션 없음.

## 한계

- 옵티마이저가 PK 역순과 보조 인덱스 사이에서 고르는 경계(몇 대부터 바뀌는지)는 재지 않았다(450대·50대는 보조 인덱스, 5천 대 이상은 PK 역순). 경계 근처 상태는 측정하지 않았다
- 한 번만 돌렸다(1회). 회차 사이 분산은 쓰기 3회 값으로만 보인다. 읽기 p50은 한 실행 안 20회 중앙값
- 단일 연결에서 한 건씩 순차 쓰기였다 — 동시 쓰기에서 인덱스가 락 경합을 늘리는지는 재지 않았다
- count는 두 경우 모두 커버링 인덱스(`terminal_status_status_c…` 또는 새 인덱스)라 시간 차이가 없다(IN_SERVICE 2.23ms 대 2.22ms)
- 다른 목록(발주·A/S·택배 수집)은 행이 적어 재지 않았다
- (리뷰 반영) ①은 변형 순서를 바꾸지 않았다 — 항상 '인덱스 없음'을 먼저 돌렸다. 버퍼 풀이 데워지는 순서 효과가 있었다면 '있음' 쪽이 유리했을 것이다. 편향이 채택 쪽이므로 "채택하지 않음" 결론은 이 효과로 뒤집히지 않는다
- (리뷰 반영) 서비스 p50에는 목록·count 두 쿼리와 ORM 처리의 고정 비용(약 2ms)이 들어 있어, 채택 기준의 "1ms 이상 감소"를 가려내는 분해능이 낮다. 쿼리만 본 `EXPLAIN ANALYZE` actual time은 오히려 새 인덱스 쪽이 느렸다(IN_SERVICE 목록 0.0994..0.142ms → 0.543..0.548ms, 한 번씩 잰 값)
- (리뷰 반영) 보조 인덱스 크기의 '있음'(16.02MB)은 그 회차 INSERT 1,000행이 들어간 뒤, '없음'(14.56MB)은 실험 ② 시작 전에 잰 값이다. +1.46MB에 1,000행분이 섞여 있어 인덱스만의 크기 차이는 이보다 조금 작다
- (리뷰 반영) 옵티마이저가 고르지 않은 계획(예: `force index (exp16_status_id)`로 DEFECTIVE·DISPOSED를 새 인덱스로 읽기)은 재지 않았다
