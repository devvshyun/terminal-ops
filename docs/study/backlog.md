# 공부거리

작업 중 나온 개념을 한 줄씩 쌓는다. 출처 기록 링크를 함께 적는다.

- [ ] MikroORM Unit of Work / Identity Map — flush 전까지 SQL이 안 나가는 이유 (설계안 5장)
- [ ] MikroORM `RequestContext` — 요청마다 EntityManager를 fork하는 이유, 워커에서는? (설계안 5장)
- [ ] 낙관적 락(version) vs 비관적 락 (설계안 7장 동시 수정 실험)
- [ ] Outbox 패턴 — 상태 변경과 알림을 왜 같은 트랜잭션에 기록하나 (F5)
- [ ] BullMQ 재시도·백오프·limiter (F3)
- [ ] Redis 정렬 집합(ZSET)으로 하트비트 최신 시각 관리 (F8)
- [ ] ESM에서 import 경로에 .js를 붙이는 이유 (decisions/0002)
- [ ] Nest APP_PIPE/APP_FILTER provider vs app.useGlobalPipes 차이 (app.module.ts)
- [ ] MikroORM RequestContext — MikroOrmModule.forRoot가 요청마다 em을 fork하는 방식 (app.module.ts)
- [ ] 마이그레이션 vs schema.refresh — 테스트에서 refresh를 쓰는 이유와 위험 (Task 2)
- [ ] swc(Vitest)는 타입을 검사하지 않는다 — 테스트와 별도로 typecheck를 돌리는 이유 (troubleshooting/0002)
- [ ] defineConfig가 엔티티 목록을 readonly로 추론하는 이유와 MikroORM 제네릭 타입 (troubleshooting/0003)
- [ ] Rel<T>와 ESM 순환 import — emitDecoratorMetadata가 클래스를 너무 일찍 참조하는 문제 (terminal.entity.ts)
- [ ] em.transactional 안에서 create만 하고 flush를 안 부르는데 저장되는 이유 (terminal.service.ts register)
- [ ] LIKE 검색어 이스케이프 (terminal.service.ts escapeLike)
- [ ] MySQL 네이티브 enum 컬럼 — 상태·출처 값을 추가할 때 ALTER가 필요한 이유와 대안(varchar+check) (Migration20261022040212)
- [ ] FK 자동 인덱스와 복합 인덱스 (terminal_id, occurred_at)가 겹치는 문제 (Migration20261022040212)
