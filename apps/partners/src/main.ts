import { createPartnersServer } from './server.js';

const port = Number(process.env.PARTNERS_PORT ?? 4010);
// 기본은 이 PC 안에서만(127.0.0.1). 시연 compose는 컨테이너끼리 부르므로 0.0.0.0 — 바깥 포트는 열지 않는다(보강 9, decisions/0087)
const host = process.env.PARTNERS_HOST ?? '127.0.0.1';
const { server } = createPartnersServer();

server.listen(port, host, () => {
  console.log(`partners listening on http://${host}:${port}`);
});

// keep-alive 연결이 남아 있으면 close가 끝나지 않으므로 연결을 먼저 끊는다.
const shutdown = () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
