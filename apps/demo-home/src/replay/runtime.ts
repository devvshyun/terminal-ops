import type { Replay } from './engine';

/**
 * 녹화 재생본에서만 있는 재생 엔진 하나(보강 11). 보통 빌드(시연 묶음)에서는 늘 null — 화면은 지금처럼 실제 API를 부른다.
 * 재생본의 시작점(`src/replay/main.tsx`)이 녹화본을 읽어 넣고, fetch를 엔진으로 바꾼다.
 */
let current: Replay | null = null;

export function setReplay(replay: Replay | null): void {
  current = replay;
}

export function getReplay(): Replay | null {
  return current;
}

/** fetch 대신: '/api/'로 시작하는 요청은 엔진이 답하고, 나머지(글꼴·사진)는 원래 fetch로 */
export function replayFetch(replay: Replay, original: typeof fetch): typeof fetch {
  return async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return original(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const reply = replay.reply(method, url.pathname + url.search);
    // 실제 네트워크처럼 한 박자 늦게 — 실행 중 단추·로딩 글이 보이게
    await new Promise((resolve) => setTimeout(resolve, 120));
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  };
}
