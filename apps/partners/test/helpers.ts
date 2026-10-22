import type { AddressInfo } from 'node:net';
import { createPartnersServer } from '../src/server.js';
import type { ConfigPatch } from '../src/state.js';

/** 빈 포트에 서버를 띄운다. 테스트 파일마다 따로 띄우므로 서로 상태를 공유하지 않는다. */
export async function startPartners() {
  const { server, state } = createPartnersServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    state,
    configure: (patch: ConfigPatch) =>
      fetch(`${base}/__admin/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }),
    reset: () => fetch(`${base}/__admin/reset`, { method: 'POST' }),
    stats: async () => (await fetch(`${base}/__admin/stats`)).json(),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export type Partners = Awaited<ReturnType<typeof startPartners>>;
