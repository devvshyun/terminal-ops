import { createSimServer } from './server.js';

const port = Number(process.env.DEVICE_SIM_PORT ?? 4020);
const { server, fleet } = createSimServer();

server.listen(port, '127.0.0.1', () => {
  console.log(`device-sim listening on http://127.0.0.1:${port}`);
});

// 하트비트 루프를 멈추고(보내던 주기는 끝까지), keep-alive 연결을 끊고 끝낸다.
const shutdown = () => {
  void fleet.close().finally(() => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
