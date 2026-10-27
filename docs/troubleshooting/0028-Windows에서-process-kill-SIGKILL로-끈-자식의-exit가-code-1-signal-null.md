# 0028. Windows에서 process.kill(pid, 'SIGKILL')로 끈 자식의 exit가 code 1·signal null

- 날짜 / 관련 기능: 2026-10-27 / F5 (Day 7 Task 5, 실험 0014)
- 증상: 실험 0014 사전 검증(계획 작성 때 임시 폴더)에서 `process.kill(w1.pid, 'SIGKILL')` 뒤 `expect(signal).toBe('SIGKILL')`이 `expected null to be 'SIGKILL'`로 실패했다. 워커는 실제로 죽었다(이후 BullMQ가 그 워커의 active job 5개를 stalled로 되살렸다). 이 저장소에서는 아래 재현 명령으로 같은 차이를 다시 확인했다.
- 가설:
  1. 프로세스가 죽지 않았다.
  2. Windows에는 POSIX 신호가 없어 node가 종료 코드로만 안다 — 무엇이 보고되는지는 kill을 누가 불렀느냐에 따른다.
- 확인:
  - 재현 스크립트(스크래치패드 `killprobe.mjs`, 저장소 밖): 자식 node 하나(`node -e "setInterval(() => {}, 1000)"`)를 띄우고 300ms 뒤 그 PID에만 SIGKILL을 보낸다. `MODE=process` → `process.kill(c.pid, 'SIGKILL')`, `MODE=child` → `c.kill('SIGKILL')`. `exit` 이벤트의 `code`·`signal`과 `exitCode`·`signalCode`·`killed`를 찍는다.
  - 명령: `MODE=process node killprobe.mjs; MODE=child node killprobe.mjs; node --version` (2026-10-27 17:3x, Windows 11)
    ```
    process.kill 10116 true
    exit {"code":1,"signal":null,"exitCode":1,"signalCode":null,"killed":false}
    child.kill 42084 true
    exit {"code":null,"signal":"SIGKILL","exitCode":null,"signalCode":"SIGKILL","killed":true}
    v24.13.1
    ```
  - 두 경우 모두 `exit`가 왔다(자식이 끝났다). 앞뒤 `tasklist //FI "IMAGENAME eq node.exe" //FO CSV //NH`가 같은 PID 3개(43936, 35448, 28868 — 이 세션 밖의 node)만 보였다 → 자식은 둘 다 죽었고 다른 node는 건드리지 않았다. 가설 1 기각.
  - 차이는 보고값뿐이다: `process.kill`은 `code 1, signal null, killed false`, `child.kill`은 `code null, signal 'SIGKILL', killed true`.
  - 해석(추정 — node·libuv 소스를 따라가 확인하지는 않았다. 확인한 것은 위 두 출력의 차이뿐): 두 길 모두 libuv가 Windows `TerminateProcess`로 끝낸다. `ChildProcess` 객체는 자기 `kill()`로 보낸 신호를 기억해 `signal`로 보고하고, 밖에서 `process.kill(pid)`로 끝낸 경우에는 종료 코드(1)만 안다.
- 원인: 가설 2. Windows에서는 신호로 종료 원인을 알 수 없고, 보고되는 값은 누가 kill을 불렀느냐에 따른다.
- 해결: 실험 헬퍼 `killWorker`(`apps/api/test/helpers/worker-process.ts`)가 `child.kill('SIGKILL')`을 쓰고 `{ code, signal }`을 돌려준다. 실험 0014 A는 `{ code: null, signal: 'SIGKILL' }`을 단언한다(두 실행 모두 통과 — experiments/0014). 두 방법 모두 그 자식의 PID에만 간다(이름으로 끄지 않는다). `stopWorker`의 "SIGTERM이 안 들으면 PID로 강제 종료"는 보고값을 단언하지 않으므로 `process.kill`을 그대로 둔다.
- 배운 것: 종료 이유를 `signal`로 판단하는 코드는 Windows에서 kill을 부른 쪽에 따라 달라진다. backlog 한 줄(Windows의 프로세스 종료와 신호).
