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
  // create는 src/migrations에 .ts를 쓰고, up은 tsc로 빌드된 dist/migrations를 실행한다.
  migrations: { path: 'dist/migrations', pathTs: 'src/migrations', emit: 'ts' },
  debug: process.env.MIKRO_ORM_DEBUG === '1',
});
