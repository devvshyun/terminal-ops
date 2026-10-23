# 0020. device-sim에서 업데이트 중에 설정을 바꾸면 단말기가 updating인 채로 남는다

- 날짜 / 관련 기능: 2026-10-23 / F8 (Day 4 Task 8)
- 증상: 계획의 `fleet.ts`를 244e851의 원자적 `configure`(새 단말기 목록을 만든 뒤 한꺼번에 바꿈)와 합치다가 코드 읽기로 의심했다. 확인용 테스트(`apps/device-sim/test/firmware.spec.ts` '업데이트 중에 설정을 바꿔도…'): updateDelayMs 50으로 HB-0001이 업데이트 중일 때 `fleet.configure({ ...fleet.config, intervalMs: 1234 })` → `settleUpdates()` → 지금 목록의 HB-0001이 `{ firmwareVersion: '2.0.0', updating: false }`여야 한다.
  - 고치기 전 결과: `AssertionError: expected { serialNo: 'HB-0001', …(3) } to match object { firmwareVersion: '2.0.0', …(1) }`, `Tests 1 failed | 7 passed (8)`. 성공 보고는 API에 갔는데 지금 목록의 단말기는 1.0.0, updating true 그대로.
- 가설: `configure`는 단말기마다 새 `Device` 객체를 만들고 `updating`을 이전 값(true)으로 옮긴다. 계획의 `startUpdate`는 시작할 때의 객체를 잡아 `report`에 넘기고, `report`는 그 객체의 `firmwareVersion`·`updating`만 바꾼다 → 새 목록의 객체는 아무도 바꾸지 않는다.
- 확인: 위 결과가 그대로 맞다(버전도 updating도 안 바뀜). 하트비트는 새 목록을 보내므로 이 단말기는 계속 1.0.0을 보내고, updating이 true라 다음 지시도 무시한다 — 영영 업데이트하지 않는다. 계획 원본의 `configure`도 새 객체를 만들고 updating을 옮기므로 같은 문제가 있었다(사전 검증 스파이크에는 업데이트 중 설정 변경 경우가 없었다).
- 원인: 객체 참조를 오래 들고 있는 비동기 작업과, 목록을 통째로 바꾸는 설정 변경이 만났다.
- 해결: 이 커밋. `report(serialNo, …)`가 끝날 때 `this.devices.get(serialNo)`로 지금 목록에서 찾아 반영한다(없으면 그 단말기는 목록에서 빠진 것이라 건너뜀). 보고 연결도 보고 시점의 `this.client`를 쓴다(설정 변경으로 닫힌 에이전트를 잡고 있지 않게). 고친 뒤 device-sim `Tests 34 passed (34)` 두 번.
- 배운 것: 바꿔 끼우는(immutable swap) 상태와 오래 걸리는 비동기 작업을 같이 쓰면, 작업은 끝날 때 키로 다시 찾는다.
