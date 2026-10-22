# 0011. 배정은 mutate로 한 UPDATE에 담는다

- 날짜 / 관련 기능: 2026-10-22 / F2
- 상황: 배정은 상태(IN_STOCK → ALLOCATED)와 가맹점을 함께 바꾼다. 상태 변경은 전이 서비스 한 곳에서만 한다(CLAUDE.md). 전이 서비스는 version 검사 UPDATE를 이력 INSERT보다 먼저 flush한다(troubleshooting/0004).
- 선택지:
  1. 전이 후 같은 트랜잭션에서 가맹점을 따로 설정: UPDATE가 두 번 나가 version이 2 오른다. 화면이 본 version과 응답 version이 2 차이 나 다음 요청의 expectedVersion 계산이 헷갈린다.
  2. 가맹점을 먼저 설정하고 전이: 전이 안 flush가 가맹점 변경까지 함께 보내 한 번이 되지만, 전이가 거절되면(422) 바깥 em에 바뀐 값이 남는다. 순서 의존이 숨는다.
  3. `TransitionCommand.mutate?: (terminal) => void`: 규칙 확인 뒤, flush 전에 적용 → 상태와 가맹점이 UPDATE 한 번, version +1. 거절되면 mutate가 호출되지 않는다.
- 결정: 3. 테스트가 version +1을 확인한다.
- 결과·대가: mutate 안에서 상태(status)를 바꾸면 규칙을 우회할 수 있다. 주석으로 금지만 해 두었다.
- 다시 볼 조건: mutate를 쓰는 곳이 늘어 실수가 보이면, 바꿀 수 있는 필드를 명시한 타입(예: `{ merchant?: Merchant }`)으로 좁힌다.
