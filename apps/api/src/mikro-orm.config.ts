import { defineConfig } from '@mikro-orm/mysql';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Migrator } from '@mikro-orm/migrations';
import { env } from './config/env.js';
import { ENTITIES } from './entities.js';

export default defineConfig({
  ...env.mysql,
  entities: ENTITIES,
  metadataProvider: ReflectMetadataProvider,
  extensions: [Migrator],
  // 연결 collation을 테이블 열(utf8mb4_0900_ai_ci)과 맞춘다(troubleshooting/0008, decisions/0025).
  // MikroORM의 맨 위 charset/collate는 mysql2 연결에 전달되지 않는다(스키마 생성과 `set names`에만 쓰임).
  // mysql2 연결 collation은 driverOptions.charset(대문자 collation 이름)으로 정해진다. 없으면 mysql2 기본 utf8mb4_unicode_ci.
  driverOptions: { charset: 'UTF8MB4_0900_AI_CI' },
  collate: 'utf8mb4_0900_ai_ci',
  // create는 src/migrations에 .ts를 쓰고, up은 tsc로 빌드된 dist/migrations를 실행한다.
  migrations: { path: 'dist/migrations', pathTs: 'src/migrations', emit: 'ts' },
  debug: process.env.MIKRO_ORM_DEBUG === '1',
});
