# 0029. swc(vitest)는 계약의 타입 별칭을 design:type에 Object로 내보낸다 (tsc 빌드는 String)

- 날짜 / 관련 기능: 2026-10-27 / 보강 1 (Task 1에서 생긴 문제, Task 2 작업 중 컨트롤러 리뷰가 지적해 확인)
- 증상: Task 1에서 `SyncRun.outcome`을 `string`에서 계약 유니온 별칭 `SyncRunOutcome`으로 좁혔다. 빌드 결과는 `__metadata("design:type", String)` 그대로라 "스키마가 바뀌지 않는다"고 기록했는데, 테스트(vitest)는 tsc가 아니라 swc로 컴파일한다.
- 가설: 별칭은 런타임에 없으니 swc가 `String`을 알 수 없고 `Object`로 내보낸다. 그러면 MikroORM이 `@Property({ length: 20 })`의 타입을 추론하지 못한다.
- 확인:
  - tsc 빌드(`npm run build`) 결과 `dist/shipment/shipment.entities.js`: `Property({ length: 20 }), __metadata("design:type", String)], SyncRun.prototype, "outcome"`.
  - 같은 소스를 vitest와 같은 설정(데코레이터 메타데이터 켬)으로 `@swc/core`에 직접 넣은 출력: `_ts_metadata("design:type", typeof SyncRunOutcome === "undefined" ? Object : SyncRunOutcome)], SyncRun.prototype, "outcome"`. `SyncRunOutcome`은 타입이라 런타임에 없으므로 `Object`가 된다.
  - 테스트는 통과했다. 즉 증상은 없었고 확인한 것은 메타데이터가 달라진다는 점뿐이다. MikroORM이 `Object`를 UnknownType으로 읽는다는 것은 컨트롤러 리뷰의 지적이며 나는 따로 확인하지 않았다.
- 원인: tsc는 별칭을 풀어 `String`을 내보내고, swc는 파일 하나만 보고 변환하므로(타입 정보 없음) 별칭을 풀지 못해 `Object` 폴백을 쓴다. 빌드와 테스트의 메타데이터가 다르다.
- 해결: `@Property({ type: 'string', length: 20 })`로 타입을 명시했다(컬럼은 그대로 varchar(20), 마이그레이션 없음). 데코레이터가 붙은 프로퍼티를 계약 별칭 타입으로 좁힐 때는 같은 문제가 생길 수 있으므로, DTO는 프로퍼티 타입을 그대로 두고 `implements`로만 모양을 검사한다(Task 2). 예외로 `ListSyncRunsQuery.outcome?: SyncRunOutcome`은 `design:type`이 `Object`가 되지만 값이 문자열 그대로라 class-transformer 변환에 영향이 없다.
- 배운 것: "빌드 결과가 같다"는 swc로 도는 테스트에 대한 증거가 아니다. 이 저장소에서 데코레이터 메타데이터를 보려면 tsc 출력과 swc 출력을 둘 다 봐야 한다.
