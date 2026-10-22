import { createPartnersServer } from './server.js';

const port = Number(process.env.PARTNERS_PORT ?? 4010);
const { server } = createPartnersServer();

server.listen(port, '127.0.0.1', () => {
  console.log(`partners listening on http://127.0.0.1:${port}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
