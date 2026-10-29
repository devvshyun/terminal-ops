# 0033. 새 앱에서 `npm install`이 `Cannot read properties of null (reading 'edgesOut')`로 멈춘다

- 날짜 / 관련 기능: 2026-10-29 / 소개 페이지(`apps/landing`, decisions/0078)
- 증상: lock 파일 없이 새 `package.json`(`vite 8.3.4`, `vitest 5.0.4`, `typescript 6.0.3`, `gsap 3.15.0`, 글꼴 셋)으로 `npm install`(npm 10.9.4, Node 22.22.0)을 돌리면 `npm error Cannot read properties of null (reading 'edgesOut')`로 끝나고 아무것도 설치되지 않았다. 두 번 돌려도 같았다
- 가설: 1) 저장소 루트에 workspaces 설정이 있어 꼬인다 2) vitest의 선택 peer 의존성 해석(arborist `#loadPeerSet`)이 새로 나온 판과 어긋난다 3) 네트워크·캐시
- 확인:
  - 저장소 루트에 `package.json`이 없다(`ls ../../package.json` → 없음) → 1 기각
  - 디버그 로그(`/root/.npm/_logs/…-debug-0.log`)의 마지막 줄들: `silly fetch manifest @vitest/browser-playwright@5.0.5` 바로 뒤에 `verbose stack TypeError: Cannot read properties of null (reading 'edgesOut')`, 스택은 `build-ideal-tree.js` `#loadPeerSet` → `#buildDepStep`
  - vitest를 빼고 설치하면 성공(`added 22 packages`). 그 뒤 `npm install --save-dev vitest@5.0.4`만 해도 같은 오류 → vitest 5.0.4가 원인 쪽
  - `vitest@5.0.5`(2026-10-15 배포)로는 성공했고, 그 lock으로 `npm ci`도 성공(`added 44 packages`), 테스트 14개 통과
  - 다른 앱(field·merchant)은 lock 파일이 있어 `npm ci`가 이 해석을 다시 하지 않는다(그래서 5.0.4로도 문제없다)
- 원인(추정): vitest 5.0.4의 선택 peer `@vitest/browser-playwright`를 해석할 때 npm이 최신인 5.0.5 매니페스트를 가져오고, 그 판의 peer(같은 판의 vitest)와 이미 고른 5.0.4가 어긋나는 peer 묶음을 arborist가 처리하다 null 노드를 만난다. arborist 코드로 확인하지는 않았다 — 로그의 마지막 매니페스트와 "5.0.5로 맞추면 된다"는 결과로 본 추정이다
- 해결: 소개 페이지는 `vitest 5.0.5`를 쓴다(다른 앱은 그대로 5.0.4). `--legacy-peer-deps`는 쓰지 않았다 — 다른 앱과 다른 해석 규칙의 lock이 생긴다
- 배운 것: 새 앱을 만들 때 lock 파일 없이 정확한 판을 고정하면, 그 판의 선택 peer가 그 사이에 새로 나온 판과 엇갈릴 수 있다. 로그의 마지막 `fetch manifest`가 실마리다 → study/backlog.md

### 보탬 (시연 도구, 2026-10-29)
- `apps/sandbox`를 새로 만들 때 같은 오류가 다시 났다(lock 없이 vitest 5.0.4). 이번에는 개발자센터 `package-lock.json`을 옮기고 contracts 줄만 빼서 `npm install` → `added 116 packages`. vitest는 다른 앱과 같은 5.0.4로 둘 수 있었다 — lock이 있으면 이 해석을 다시 하지 않는다는 위 확인과 같다
