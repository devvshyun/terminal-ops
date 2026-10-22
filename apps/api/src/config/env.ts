import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// 스크립트·테스트는 apps/api에서 실행한다. 저장소 루트의 .env를 읽는다.
const envFile = resolve(process.cwd(), '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const env = {
  port: Number(process.env.API_PORT ?? 3000),
};
