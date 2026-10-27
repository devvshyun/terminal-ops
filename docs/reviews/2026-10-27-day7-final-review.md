# Day 7 최종 리뷰 (2026-10-27)

- 범위: `0f85411..ebff57f` (day7-wrapup, 커밋 15개: docs 6, feat 2, fix 3, refactor 1, exp 3). 75파일, +7,174 / −156(그중 계획 문서 3,855줄)
- 판정: **병합 가능(기록 보탬 권장)**. Critical과 Important는 없다. Minor 8건은 대부분 기록·설명 보탬이다. 병합 전에 Minor 1(브라우저 확인 결과 기록)만 하길 권한다

## 범위
- 이월 정리(api, 0cfccb4)
  - QUEUED outbox 복구 sweep: `requeueStale()`. 행은 그대로 두고, 큐에 job이 없을 때만 같은 jobId로 다시 넣는다. 주기 작업 `outbox-requeue`(decisions/0042)
  - 데드락 1213을 409 `DEADLOCK`으로 바꿨다(decisions/0043)
  - 배포 목록 단계 통계를 `rollout_id in (…) group by` 한 쿼리로 바꿨다(Day 6 Minor 10)
  - 단말기 목록 `page`·`q`에 상한을 걸었다(Day 6 Minor 11). 실험 0013 표현도 고쳤다
- 어드민 쿼리 키 팩토리(3b76cb7): `api/query-keys.ts`, 빠진 무효화 두 곳, DEADLOCK 안내(Day 6 Minor 4)
- 대시보드(ae0c05c, 9007676, 47f87fe, a32d3f4)
  - `GET /dashboard/summary`: 집계 일곱 쿼리를 한 RR 읽기 전용 트랜잭션에서 돌린다
  - Redis 캐시 `<prefix>:dash:summary`: 30초 TTL, 프로세스 안 single-flight. `refresh=true`는 진행 중인 일반 집계에 합류하지 않는다. `lastWrittenAt`으로 옛 집계가 새 캐시를 덮지 않게 한다
  - 어드민 처음 화면: 카드 7장, "N초 전 기준"(`useNow` 5초), 새로고침
- 실험 0014 워커 강제 종료(partners 톡톡 `delayMs`), 0015 대시보드 캐시 전후, 0016 `(status, id)` 인덱스(채택하지 않음)
- README(실험 결과 표 16행, 설계안 7장 대응 9행), `scripts/docs-index.mjs` + `docs/index.md`(`--check`), backlog 주제별 8절, `docs/retrospective.md`
- 기록: decisions 0042~0046, troubleshooting 0028, experiments 0014~0016, devlog `# Day 7` 15개 항목과 7일차 요약

## 검증 결과 (리뷰어가 직접 실행)
- admin `npx vitest run`: `Test Files 12 passed (12)`, `Tests 108 passed (108)`, 5.38초. `tsc --noEmit -p .` exit 0
- admin `npx vite build`: `index-*.js 351.94 kB`(gzip 106.35 kB), `✓ built in 120ms`, exit 0. `dist/`는 `.gitignore`라 추적되지 않는다
- api `npx tsc --noEmit`: exit 0
- device-sim `npx vitest run`: `4 passed (4)` / `40 passed (40)`. tsc exit 0
- `node scripts/docs-index.mjs --check`: `docs/index.md 최신`(exit 0)
- `git status --short`: 출력 없음. 이 리뷰 파일은 빼고 센 것이다(커밋하지 않았다). `.claude/`도 이제 ignore돼 나오지 않는다
- 기록 정합성
  - devlog Day 7 제목 시각 15곳이 커밋 15개의 시각(`--date=format:%H:%M`)과 모두 같다
  - 번호는 decisions 0042~0046, troubleshooting 0028, experiments 0014~0016으로 빈 번호 없이 이어진다. README의 "결정 46·트러블슈팅 28·실험 16"과 `docs/index.md` 절 제목 수가 같다
  - README의 `apps/…` 경로와 마크다운 링크, 회고의 링크는 모두 실제로 있는 파일을 가리킨다(스크립트로 전수 검사, 없는 것 0)
  - README에 인용한 e2e 테스트 이름 3개(scan 2, replacement 1)는 테스트 파일에 그대로 있다
  - README의 0014·0015·0016 숫자는 실험 기록 원문 로그와 같다. 0014는 SENT 90, waiting 205·active 5, 중복 5, 61,422·61,424ms, sweep 210/0, B 4,165·4,211ms. 0015는 169.1·172.5ms, 0.4ms, SELECT 350·7, 1,502/1,487ms. 0016은 p50 2.89→2.84ms, UPDATE +6.1%, INSERT +4.1%, +1.46MB
- 회고 표와 git 기록 대조
  - 테스트 수 7행은 각 날 devlog "N일차 요약"의 **테스트** 줄과 모두 같다(Day 5 "최종 리뷰 반영 뒤 58/398"은 6일차 요약, Day 6 "10/93"은 최종 리뷰 반영 정리에서 확인)
  - 커밋 범위는 설계안 8장 ✅ 칸과 같다. Day 7 칸은 `ac5d372..ebff57f`로 채워져 있다
  - 누적 기록 수는 `git ls-tree`로 셌다
    - Day 1·2·3·6은 각 날 마감 커밋과 같다: 6/4/2, 16/7/5, 25/15/7, 41/27/13
    - Day 4·5는 요약 시점 값이다: 31/20/10, 36/24/12
    - Day 4·5 병합 커밋에서는 트러블슈팅이 21·25다. 최종 리뷰에서 0021·0025가 더해졌다(Minor 6)
  - "계획 합계 40,787줄, Day 4 7,970줄"은 `wc -l` 결과와 같다
  - "QUEUED 복구는 Day 2에 적음"(decisions/0016 "알려진 한계"), "1213은 Day 1에 적음"(devlog 2026-10-22 109·226·512행)도 원문과 맞다
- 회고 "이미지 이름으로 프로세스를 끈 사고"
  - 저장소 전체를 `taskkill|IMAGENAME|이미지 이름`으로 찾았다. 걸린 곳은 Day 3 이후 계획의 안전 규칙, 0014·0028, 회고뿐이고, 사고 경위를 적은 기록은 없다
  - 회고의 "저장소에 이 사고의 기록이 없다"와 "Day 3 계획 이전"은 정확하다. 컨트롤러 설명(Day 1~2 무렵, 대화로만 보고)과도 맞는다
- 직접 하지 않은 것(지시에 따라)
  - api·partners 테스트: 미리보기 서버(3000·4010·5173)가 사용자용으로 떠 있다
    - api 65/446은 Task 9 구현자가 ebff57f에서 돌린 값이다(devlog 18:21: 229.63초, `Connection is closed` 0줄, `MaxListenersExceededWarning` 5줄은 Day 1부터 있던 것)
    - partners 6/53도 같은 항목의 값이다
  - 서버 기동과 `db:migration:check`(devlog 18:21에 `최신 상태`)
  - 화면 확인: 컨트롤러가 개발 DB에서 내장 브라우저로 봤다. 단말기 14, 운영 중 7(온라인 0·오프라인 6·기록 없음 1), 열린 이상 1, VAN 어긋남 2, 이번 주 전이 25, "KST 기준 (0초 전)", 새로고침 버튼. 이 숫자는 devlog 실서버 스크립트 출력(단말기 14, 운영 중 7, 온라인 0, 열린 이상 1, 이번 주 전이 25)과 같다

## Strengths
- **복구 sweep을 행 상태가 아니라 큐 상태에 맞췄다.**
  - `requeueStale`은 QUEUED 행을 PENDING으로 되돌리지 않는다. `getJobState === 'unknown'`인 행에만 같은 jobId로 notify job을 다시 넣는다
  - 그래서 살아 있는 job(대기·처리 중·지연)은 건드리지 않는다. relay의 SKIP LOCKED 행과 다투지 않고, project job도 다시 넣지 않는다
  - 실험 0014 A가 이 성질을 숫자로 보였다: 죽인 직후 sweep이 QUEUED 210행을 보고 다시 넣은 것 0
  - B는 `drain()`으로 job 유실을 흉내 냈다. 워커만으로는 3초 동안 0건이었고, sweep이 300/300을 다시 넣어 중복 0으로 끝났다
  - `removeOnComplete/Fail` 전제와 그 전제가 깨질 때의 위험이 주석에 적혀 있다. 경쟁 경우도 무해하다: 행을 읽은 뒤 notify가 SENT를 쓰고 job이 지워진 사이에 다시 넣어도, notify가 SENT 행을 `SKIPPED`로 끝낸다
- **대시보드 캐시의 동시성 규칙이 e2e로 하나씩 잠겨 있다.**
  - `dashboard.e2e.spec.ts`의 10개 테스트가 다음을 각각 단언한다
    - 일반 집계 중 refresh는 합류하지 않는다
    - 늦게 끝난 옛 집계가 덮지 않는다
    - refresh끼리는 합류한다
    - refresh 중의 일반 요청은 refresh에 합류한다
    - 집계가 실패하면 inflight를 해제한다
    - Redis get·set이 실패해도 200이다
  - 두 핵심 줄은 일부러 되돌려 테스트가 실제로 깨지는 것까지 확인했다(single-flight `if (true)`, `lastWrittenAt` 조건)
  - 화면은 cancelQueries 뒤에 `setQueryData`를 부른다. 그래서 진행 중이던 옛 조회가 새로고침 결과를 덮지 않는다
- **실험을 "결론이 틀렸다"까지 고쳤다.** 0015 ④ 해석 오류를 원문 숫자로 다시 계산해 정정했다. `lastWrittenAt` 방어가 이 실험에서는 발동하지 않았고 e2e로만 검증됐다는 것을 실험·결정·devlog·회고 네 곳에 같은 말로 적었다. "61초 대부분이 lockDuration + stalledInterval"과 0045의 "1~2ms 안쪽"에도 추정 표시를 했다. 측정한 것과 추정한 것을 나누는 규칙이 마지막 날까지 지켜졌다
- **0016은 채택 기준을 먼저 정하고 쟀다.** 기준은 "p50 2배 이상 그리고 1ms 이상 감소"였다. 결과가 기준에 걸리지 않아 마이그레이션 없이 끝냈다. 한계 절에 측정 편향도 적었다: 순서 효과는 채택 쪽으로 기울어 결론에 안전하다는 것, 분해능 약 2ms, EXPLAIN에서는 새 인덱스가 오히려 느렸다는 것
- **Day 6 이월이 빠짐없이 정리됐다.** Day 6 최종 리뷰의 "Day 7 이월 목록"과 devlog "Day 7로 넘긴 것"을 하나씩 대조했다. 각 항목은 Day 7에 닫혔거나(Minor 4·10·11, QUEUED 복구, 1213, 0013 표현, 상태 조건 인덱스, 대시보드 캐시 실험, README 결과 표, 미리보기 전 점검) 회고 6장에 남아 있다(Minor 7의 `failStale`, 6일차 남은 문제, Day 4·5 이월 전부). 사라진 항목은 없다
- **README가 그대로 따라 할 수 있는 수준이다.**
  - 실행 순서가 실제 스크립트와 맞는다: `--wait`(두 서비스에 healthcheck 있음), `npm ci`(네 앱 모두 lock 있음), `db:migrate`·`db:seed`·`start:worker`·`scheduler:clear`(api package.json에 모두 있음)
  - 설계안 7장 대응표는 실험이 없는 두 항목(같은 박스 재스캔, 교체 출고 실패)을 "실험 기록 없음 — e2e 테스트"로 솔직히 적고 테스트 이름까지 인용한다
- **회고가 정직하다.**
  - 이미지 이름 사고에 기록이 없다는 것 자체를 "기록 규칙 위반"이라고 적었다
  - "틀린 적은?"에 0015 ④를 그대로 넣었다
  - 반복 횟수(0016 1회, 0014·0015 2회)와 단일 PC 한계를 "안 된 것"에 적었다

## Issues

### Critical
없음.

### Important
없음.

### Minor

1. **컨트롤러 화면 확인 결과가 devlog에 아직 없다(Day 6 Minor 9와 같은 형태)**
   - 위치: `docs/devlog/2026-10-27.md:736` "화면 확인(처음 화면 카드·"N초 전 기준"·새로고침): 컨트롤러 확인 대기", `:793`
   - 문제: 컨트롤러가 확인한 결과(위 "직접 하지 않은 것"의 숫자)가 기록에 없다. 회고 3장은 "결과 기록이 늦었다"를 이미 반복된 일로 적어 두었다
   - 수정: Day 6의 13:13 항목처럼 확인 항목을 하나 덧붙인다(그 기록 커밋 시각으로 제목). 내용은 받아 적은 것이라는 표시, 숫자, 콘솔 오류 여부, 개발 DB에 남은 것 없음(읽기만)이다. 7일차 요약 "다음에 할 것"의 화면 확인 줄도 고친다
2. **새로고침을 첫 조회 중에 누르고 실패하면 "불러오는 중"에 머문다(코드로 본 추정, 재현하지 않음)**
   - 위치: `apps/admin/src/pages/HomePage.tsx:95, 117`
   - 문제:
     - `onMutate`의 `cancelQueries`는 기본 `revert: true`라 데이터가 없는 첫 조회를 취소하면 `status: 'pending'`·`fetchStatus: 'idle'`로 돌아간다
     - 새로고침이 성공하면 `setQueryData`로 풀린다
     - 실패하면 다시 조회할 계기(창 포커스·다시 마운트)가 올 때까지 `role="status"` "불러오는 중"과 새로고침 오류가 함께 남는다
   - 수정: `onError: () => client.invalidateQueries({ queryKey: keys.dashboard })`를 두거나, 첫 데이터가 없을 때는 취소하지 않는다(`if (client.getQueryData(keys.dashboard)) await client.cancelQueries(…)`). 테스트: 첫 조회를 붙잡아 둔 채 새로고침 500 → 첫 조회가 다시 나가는지
3. **주기 작업 `requeue` 경로(scheduler → processor → `requeueStale()`)를 지나는 테스트가 없다**
   - 위치: `apps/api/src/outbox/outbox.processor.ts:15`, `apps/api/test/outbox-requeue.e2e.spec.ts`
   - 문제:
     - e2e와 실험 0014는 모두 `requeueStale({ staleMs: 0, … })`을 직접 부른다
     - `scheduler.e2e`는 등록 개수만 센다
     - 그래서 기본값(60초·limit 100)으로 job 이름 `requeue`가 processor 분기에 닿는지는 검증되지 않았다. 이름이 어긋나면 `UnrecoverableError('모르는 outbox job')`로 조용히 실패한다
   - 수정: processor 단위 테스트 하나를 둔다(`process({ name: 'requeue' })` → `requeueStale` 호출). 또는 e2e에서 `queue.add('requeue', {})` 뒤 job 결과의 `requeued`를 본다
4. **새 env 세 개가 `.env.example`에 없다**
   - 위치: `.env.example`, `apps/api/src/config/env.ts`의 `OUTBOX_REQUEUE_INTERVAL_MS`·`OUTBOX_REQUEUE_AFTER_MS`·`DASHBOARD_CACHE_TTL_MS`
   - 문제: 다른 주기 값(`SWEEP_INTERVAL_MS`, `RELAY_INTERVAL_MS`, `ACTIVE_REBUILD_INTERVAL_MS` …)은 결정 번호 주석과 함께 예시 파일에 있다. 새 셋만 빠졌다
     - 화면의 안내 문구 "최대 30초"(`HomePage.tsx:125`)는 TTL을 바꾸면 틀린다. 응답에 TTL이 없어 화면이 알 길도 없다
   - 수정: `.env.example`에 세 줄을 더한다(`# Day 7 — decisions/0042`, `0044`). 화면 문구는 "서버가 짧게(기본 30초) 재사용하는"으로 바꾼다
5. **README 실험 재현 줄에 빌드 전제가 빠졌다**
   - 위치: `README.md:47`
   - 문제: 실험 0014(그리고 0005)는 `dist/worker.js`를 자식 프로세스로 띄운다. 빌드하지 않았으면 `beforeAll`이 "먼저 npm run build 하세요"로 멈춘다. 소스만 고치고 빌드를 잊으면 옛 워커로 잰다. 이쪽은 아무 경고가 없다
   - 수정: "워커 프로세스를 띄우는 실험(0005·0014)은 먼저 `npm run build`"를 한 줄 더한다
6. **회고 1장 표의 "기록(누적)" 열의 기준이 적혀 있지 않다**
   - 위치: `docs/retrospective.md:7, 12-13`
   - 문제:
     - 테스트 열은 "그날 N일차 요약 시점"이라고 밝혔다. Day 5는 "최종 리뷰 반영 뒤"도 덧붙였다
     - 기록 열은 기준이 없다. 실제로는 요약 시점 값이다
     - Day 4(트러블 20)와 Day 5(24)는 그날 병합 커밋에서 21·25다. 최종 리뷰가 0021·0025를 더했다
     - 2장이 "리뷰가 실제 결함을 잡았다"의 예로 0021을 드는데, 표의 Day 4 수에는 0021이 빠져 있다
   - 수정: 열 제목을 "(요약 시점)"으로 하고 Day 4·5에 "(병합 시 21 / 25)"를 붙인다
7. **계획과 다른 순서·병렬 진행이 7일차 요약 "계획과 달라진 점"에 없다**
   - 위치: `docs/devlog/2026-10-27.md:519, 538, 552`(항목에는 적힘), `:783-787`(요약에는 없음)
   - 문제:
     - 계획은 "순서대로 한다(의존)"였다. 실제 커밋은 Task 2 → 4 → 1 → 3 순서다
     - 그래서 3b76cb7은 api가 아직 주지 않는 `DEADLOCK`을 안내한다. 47f87fe·a32d3f4는 아직 없는 `/dashboard/summary`를 부른다. 이 세 커밋에서 처음 화면은 404 오류 상자를 띄운다
     - 데이터 위험은 없다. api 전체 테스트 실행 시각도 겹치지 않는다(17:19~17:23, 17:25~17:29). 다만 bisect·회고에서 헷갈린다
   - 수정: 요약 "계획과 달라진 점"에 한 줄. 내용은 "Task 1·3(api)과 Task 2·4(admin)를 병렬로 진행해 admin 커밋이 먼저 들어감, 중간 커밋 3개는 처음 화면 404"이다
8. **작은 것들(선택)**
   - (a) `HomePage.tsx:40-45` "접속 상태" 카드는 MySQL 스냅샷 기준이다(주간 리포트와 같은 창). 단말기 상세의 실시간(Redis) 값과 다를 수 있다. 미리보기(`RUN_SCHEDULERS=0`)에서는 스냅샷 job이 돌지 않아 온라인이 늘 0이다. 컨트롤러 확인의 "온라인 0"도 이 때문으로 보인다(추정). 카드에 "스냅샷 기준(최대 N분 늦음)" 한 줄을 더하거나 decisions/0044에 적는다
   - (b) `scripts/docs-index.mjs:17-28`은 번호 중복(같은 0042 두 파일)과 빈 번호를 잡지 않는다. `--check`가 "색인 최신"이라고 해도 번호 충돌은 지나간다. `m[1]`을 모아 중복이면 멈추는 줄 하나면 된다
   - (c) 회고 4장 이미지 이름 행의 "초기에 한 번(Day 3 계획 이전)"에 "Day 1~2 무렵, 대화로만 보고됨"을 덧붙이면 출처가 분명해진다. Day 3 Task 1의 테스트 DB 사고(troubleshooting/0009)는 기록이 있어 표에 없어도 된다

## 남은 이월 목록
회고 6장(`docs/retrospective.md:65-79`)이 이월을 모두 담고 있다. 이 리뷰가 보탤 것은 아래뿐이다.
- 이 리뷰의 Minor 2(첫 조회 중 새로고침 실패), 3(`requeue` 경로 테스트), 4(`.env.example`·화면 문구), 5(README 빌드 전제), 8(접속 카드 기준·색인 번호 중복 검사)
- 회고 6장 그대로 남는 것
  - 화면: 운영 배포·로그인·권한·브라우저 자동 테스트, 등록·배포 생성 화면, 이상 찾기 실행 기록 표
  - 목록: 검수 기록 목록 페이지 조건, 주간 리포트 목록 filesort
  - 주간 리포트: at-least-once·고아 파일·잠금 약 10.6분·4주 밖 미전송 주
  - VAN: 시리얼 가정, 전송 대기, `failStale`의 큐 대기 행(Day 5 Minor 2·Day 6 Minor 7)
  - 이상: 정렬 인덱스, `status_changed_at` 백필
  - 데이터가 든 DB의 down 한 바퀴
  - Day 4: 같은 버전 재배포 단계 지연, 하트비트 버전 신뢰
  - Day 7 새것: 1205 응답, 대시보드 다중 프로세스 잠금, QUEUED 복구 limit 100 커서, `(status, id)` 경계·`force index`, stalled 약 61초 분해
  - `MaxListenersExceededWarning` 원인 확정
- 개발 DB·Redis 상태: Day 6 끝과 같다(Day 7 실서버 확인은 읽기만). 남은 것은 `terminal-ops:dash:summary`(30초 TTL로 사라짐)뿐이다. job scheduler는 0개다

## Assessment
**병합 가능(Ready to merge). Minor 1을 먼저 기록하길 권한다.**
- 통과한 것
  - 리뷰어 실행: admin 108, device-sim 40, admin·api·device-sim typecheck, admin 빌드, 색인 `--check`
  - 구현자 기록(ebff57f): api 446, partners 53
  - 기록 정합성: devlog 시각 15/15, 번호 연속, README·회고 링크와 경로 전수
- 맞춰 본 것
  - 회고 표의 테스트 수 7행과 기록 수를 devlog·git 트리와 대조했다. 어긋난 것은 기준 표시 하나다(Minor 6)
  - README 실험 숫자는 원문 로그와 같다
  - Day 6 이월은 닫혔거나 회고 6장에 남았다
- 통합 지점은 서로 맞물린다
  - outbox: relay → QUEUED → 강제 종료 → stalled 복구, 또는 job 유실 → sweep
  - 대시보드: API → 캐시 → single-flight·refresh·`lastWrittenAt` → 어드민 `keys.dashboard`·`setQueryData`
  - 남은 틈은 첫 조회 중 새로고침 실패(Minor 2)와 주기 job 경로 테스트(Minor 3)다. 둘 다 데이터를 깨뜨리지 않는다
- 7일 마감 기록으로서 회고는 숫자와 근거 링크가 맞고, 실수와 측정하지 않은 것을 숨기지 않았다
