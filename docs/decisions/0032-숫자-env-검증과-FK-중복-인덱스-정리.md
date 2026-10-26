# 0032. 숫자 env 검증과 FK 중복 인덱스 정리

- 날짜 / 관련 기능: 2026-10-26 / 공통 (Day 4 리뷰 Minor "새 env 주기값 NaN 검사 없음", "firmware_rollout_target_rollout_id_index 중복 인덱스")

## 숫자 env

- 상황: `Number(process.env.X ?? 기본값)`은 `abc`·`10s`를 NaN, `1.5`를 1.5로 그대로 넘긴다. NaN 주기는 BullMQ가 `Either .pattern or .every options must be defined`라는 엉뚱한 메시지로 시작을 막고, 판정 기준(HEARTBEAT_OFFLINE_AFTER_MS)이 NaN이면 비교가 늘 거짓이라 조용히 오프라인 판정을 안 한다(사전 검증).
- 선택지:
  1. 그대로 둔다.
  2. 쓰는 곳마다 검사한다.
  3. **env를 읽는 한 곳에서 정수·범위를 검사하고, 실패하면 시작하지 않는다.**
  4. 스키마 라이브러리(zod 등). 의존성이 늘고 숫자 몇 개에는 과하다.
- 결정: 3. `intFromEnv(name, fallback, { min, max })`. 범위는 포트 0~65535, 주기·제한 시간 1ms~하루, 개수·속도 1~100,000(이후 Task에서 기준일 1~365). `Number()`가 받아 주는 `1e3`·`0x10`도 거절한다(글자 그대로 정수만).

## FK 열 단독 인덱스

- 상황: MikroORM은 ManyToOne마다 FK 열 인덱스를 만든다(`initIndexes`의 `prop.index ??= true`). 같은 열로 시작하는 unique·복합 인덱스가 이미 있으면 단독 인덱스는 쓰기(INSERT·UPDATE마다 B-tree 하나 더)와 공간만 늘린다. `information_schema.statistics`로 찾은 6개:

  | 테이블 | 지운 인덱스 | 대신하는 인덱스 |
  |---|---|---|
  | carrier_event | carrier_event_shipment_id_index | unique (shipment_id, event_key) |
  | firmware | firmware_model_id_index | unique (model_id, version) |
  | firmware_rollout_target | firmware_rollout_target_rollout_id_index | unique (rollout_id, terminal_id) |
  | inspection_item | inspection_item_model_id_index | unique (model_id, code) |
  | service_ticket | service_ticket_terminal_id_index | (terminal_id, status) |
  | terminal_status_history | terminal_status_history_terminal_id_index | (terminal_id, occurred_at) |

- 선택지:
  1. 그대로 둔다.
  2. **`index: false` + drop index 마이그레이션.**
  3. 복합 인덱스 쪽을 지운다. unique가 업무 규칙이라 지울 수 없다.
- MySQL 확인(테스트 DB 임시 테이블, root): FK에는 그 열로 시작하는 인덱스가 꼭 있어야 한다. 덮는 복합 인덱스가 있는 z_child는 단독 인덱스가 지워지고, 없는 z_alone은 거절됐다. 임시 테이블은 마지막 drop table로 남기지 않았다.
  ```
  INDEX_NAME
  PRIMARY
  z_child_parent_id_id_index
  z_child_parent_id_id_index
  ERROR 1553 (HY000) at line 1: Cannot drop index 'z_alone_parent_id_index': needed in a foreign key constraint
  ```
  (z_child에서 `PRIMARY`와 복합 인덱스의 두 열이라 `z_child_parent_id_id_index`가 두 줄 나온다.) 새로 만드는 테이블에서도 MikroORM이 unique·복합 인덱스를 FK보다 먼저 만들어 MySQL이 따로 인덱스를 만들지 않는지는 빈 DB 마이그레이션 체인으로 확인한다(Task 11).
- 결정: 2. 쓰기 비용 숫자는 실험 0011(Task 9)에서 terminal_status_history로 잰다.
- 결과·대가: FK 열 단독 조회(`where terminal_id = ?`)는 복합 인덱스의 앞부분을 쓴다. 복합 인덱스의 키가 길어 단독 인덱스보다 조금 더 읽는다.
- 다시 볼 조건: 복합 인덱스를 지우거나 열 순서를 바꿀 때(FK가 기댈 인덱스가 없어지면 MySQL이 거절한다), 새 엔티티를 만들 때 같은 중복이 생기는지(`index: false`를 잊으면 생긴다).
- 참고: `terminal_status_index`(status 단독)는 Task 5에서 `(status, status_changed_at)`을 만들 때 함께 지운다(decisions/0034).
