import { createPartnersServer } from './server.js';

const port = Number(process.env.PARTNERS_PORT ?? 4010);
const { server } = createPartnersServer();

server.listen(port, '127.0.0.1', () => {
  console.log(`partners listening on http://127.0.0.1:${port}`);
});

// keep-alive 연결이 남아 있으면 close가 끝나지 않으므로 연결을 먼저 끊는다.
const shutdown = () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
