# 0028. 운영 중 단말기 목록은 Outbox 소비자와 주기 재구성으로

- 날짜 / 관련 기능: 2026-10-23 / F8, F5
- 상황: 하트비트는 운영 중(IN_SERVICE) 단말기만 받는다(회수·폐기된 단말기의 하트비트로 접속 상태가 생기면 안 된다). 하트비트마다 MySQL로 상태를 보면 decisions/0027의 의미가 없다. 그래서 Redis에 사본(active)을 두는데, 사본이 원본(terminal.status)과 어긋나지 않게 맞춰야 한다.
- 자료구조: SET 대신 **HASH(serialNo → terminal.id)**. 스냅샷·판정·실험용 MySQL 쓰기가 terminal_id를 알아야 해서 SET이면 매번 시리얼로 id를 조회해야 한다. 하트비트의 확인은 `HMGET`(없으면 null)로 같다.
- 선택지(맞추기):
  1. 주기 재구성만: 가장 단순하다. 설치 확인 뒤 최대 재구성 주기(60초) 동안 하트비트가 IGNORED가 된다.
  2. 전이 트랜잭션 안에서 Redis를 바로 고치기: 롤백되면 Redis만 바뀐 채 남고, 커밋 뒤에 고치면 그 사이 죽을 때 잃는다(decisions/0016에서 알림에 대해 본 문제와 같다).
  3. **Outbox 이벤트의 두 번째 소비자 + 주기 재구성**: 커밋된 전이만 relay가 보고, notify처럼 jobId 멱등으로 큐에 넣는다. 빠르게(relay 주기 2초) 맞추고, 재구성이 이벤트 유실·순서 뒤바뀜·워커 여러 개의 겹침을 메운다.
- 결정: 3. project job은 이벤트의 toStatus가 아니라 MySQL의 **지금 상태**를 다시 읽는다. 같은 단말기의 이벤트가 늦게·뒤바뀐 순서로 처리돼도 결과는 마지막 커밋 상태다(멱등). device 큐는 concurrency 1이라 한 워커 안에서는 읽기와 쓰기 사이에 다른 갱신이 끼지 않는다.
- 왜 둘 다인가: 이벤트만 있으면 Redis 유실(재시작·장애), job 최종 실패, 워커 2개가 같은 단말기를 동시에 처리하는 틈(읽고 쓰는 사이 역전)을 메울 수 없다. 재구성만 있으면 반영이 최대 60초 늦다. 재구성은 임시 키 → PERSIST → RENAME이라 도중에도 하트비트가 빈 목록을 보지 않는다.
- 결과·대가: relay가 Redis 왕복을 한 번 더 한다(IN_SERVICE 진입·이탈 행이 있을 때만). 재구성이 읽은 스냅숏보다 늦게 커밋된 전이는 RENAME에 덮일 수 있다. 얼마나 오래 어긋나는지는 워커 프로세스 수에 달렸다(2026-10-23 정정, 처음에는 "다음 이벤트·재구성까지, 창은 재구성 한 번의 시간"이라고 뭉뚱그려 적었다). ① 워커 프로세스가 하나면: 그 전이의 project job은 relay가 커밋 뒤에 넣고, device 큐가 concurrency 1이라 재구성이 끝난(RENAME 뒤) 다음에야 돈다 → 덮인 값을 바로 다시 고친다. 어긋남은 잠깐(대략 relay 주기 + 재구성 한 번의 시간)이다. ② 워커 프로세스가 여럿이면: 다른 프로세스의 project job이 재구성의 SELECT와 RENAME 사이에 먼저 끝날 수 있고, 그러면 RENAME이 더 새로운 반영을 덮은 채 남는다 → 그 단말기의 다음 이벤트나 다음 재구성(최대 60초)까지 어긋난다. 재구성은 IN_SERVICE 전체를 읽는다(5,000대면 status 인덱스로 한 번).
- 다시 볼 조건: 운영 중 단말기가 수십만이 되어 재구성 한 번이 무거워질 때(증분으로), device 큐의 다른 job(판정·배포)이 길어져 project가 밀릴 때(큐 나누기).
- 갱신(2026-10-23, Task 4 리뷰): **project job 유실 경로와 수정**(troubleshooting/0018). relay가 notify → project 순서로 넣다가 project addBulk가 실패하면, 트랜잭션은 롤백돼도 이미 들어간 notify job이 행을 SENT로 바꿔 다음 relay가 그 행을 잡지 않았다 → project job이 영영 안 들어가고 다음 재구성까지 active에서 빠졌다(테스트로 재현: 실패한 relay 뒤 행 상태 SENT, active 없음). 멱등인 소비자(project)를 **먼저**, 행 상태를 바꾸는 notify를 **나중에** 넣도록 바꿨다. notify가 실패하면 둘 다 다시 relay되고, 먼저 들어간 project job은 jobId 중복으로 무시되거나 한 번 더 돌 뿐이다(지금 상태를 다시 읽어 결과가 같다). 같이: project payload의 serialNo가 글자가 아니면 `UnrecoverableError`(재시도 없음). 검사는 relay가 아니라 소비자(`ActiveSetService.apply`)에 둔다 — relay에서 던지면 그 행 하나가 relay 전체를 막는다.
