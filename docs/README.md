# 기록 양식

| 폴더 | 언제 | 파일명 |
|---|---|---|
| `devlog/` | 작업 단위가 끝날 때마다 | `YYYY-MM-DD.md` (하루 한 파일에 덧붙임) |
| `decisions/` | 무언가를 골랐을 때 | `NNNN-제목.md` |
| `troubleshooting/` | 막혔을 때 | `NNNN-제목.md` |
| `experiments/` | 숫자를 쟀을 때 | `NNNN-제목.md` |
| `study/backlog.md` | 나중에 공부할 개념이 나왔을 때 | 한 파일에 한 줄씩 |
| `specs/`, `plans/` | 설계·구현 계획 | `YYYY-MM-DD-제목.md` |

번호(NNNN)는 폴더마다 0001부터.

기록 색인은 [`docs/index.md`](index.md) — `node scripts/docs-index.mjs`로 만들고 `--check`로 확인한다(손으로 고치지 않는다, decisions/0046).

---

## devlog

```markdown
# 2026-10-23

## 10:30 F2 상태 전이 서비스 (커밋 abc1234)
- 한 일: 전이 규칙 설정 파일, TransitionService, 이력 엔티티
- 막힌 것: flush 전에 이력 id가 비어 있음 → troubleshooting/0002
- 결정: 전이 규칙을 YAML 대신 TS 객체로 → decisions/0003
- 다음: 동시 수정 테스트
```

## decisions

```markdown
# 0003. 전이 규칙을 TS 객체로 정의한다

- 날짜 / 관련 기능: 2026-10-23 / F2
- 상황: 모델별로 허용 전이가 다르다(SN-200은 회수 후 재검수 필수).
- 선택지:
  1. YAML 파일 — 장점 / 단점
  2. TS 객체 — 장점 / 단점
  3. DB 테이블 — 장점 / 단점
- 결정: 2. 이유:
- 결과·대가: 규칙을 바꾸려면 배포가 필요하다.
- 다시 볼 조건: 운영자가 규칙을 직접 바꿔야 하는 요구가 생기면 3으로.
```

## troubleshooting

```markdown
# 0002. flush 전 이력 id가 undefined

- 날짜 / 관련 기능: 2026-10-23 / F2
- 증상: (에러 메시지·출력 그대로)
- 가설: 1) … 2) …
- 확인: (실행한 명령과 결과) → 가설 1 기각, 2 확인
- 원인: MikroORM은 flush 전까지 INSERT를 하지 않는다(Unit of Work).
- 해결: (커밋 해시)
- 배운 것: → study/backlog.md에 추가
```

## experiments

```markdown
# 0001. 번개택배 중복 이벤트 멱등 처리

- 날짜 / 관련 기능: 2026-10-24 / F3, F12
- 질문: 중복률 30%일 때 이벤트가 두 번 반영되는가?
- 설정: partners 설정값, 운송장 수, 워커 수
- 재현: (명령 그대로)
- 결과: (원본 숫자·표)
- 결론:
- 한계: (측정 환경, 못 잰 것)
```

## study/backlog.md

```markdown
- [ ] MikroORM Identity Map — 같은 요청에서 같은 엔티티를 두 번 조회하면? (troubleshooting/0002)
- [ ] BullMQ limiter와 group limiter 차이 (decisions/0005)
```
