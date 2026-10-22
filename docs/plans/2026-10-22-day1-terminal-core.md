# Day 1 — 단말기 등록·상태 전이·검수 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **기록 규칙 필수**: 이 저장소의 `CLAUDE.md`를 먼저 읽는다. 모든 Task는 마지막에 `docs/devlog/<오늘>.md`에 항목을 덧붙이고, Task에 적힌 결정·트러블슈팅·실험 기록을 쓴 뒤 **코드와 같은 커밋**에 넣는다. 예상과 다른 에러를 만나면 고치기 전에 `docs/troubleshooting/`에 기록을 시작한다.

**Goal:** 가상 결제단말기 운영사 "단말온"의 API 서버 골격을 세우고 F1(단말기 등록·조회), F2(상태 전이 + 이력), F13(검수 체크리스트)을 만든다. 같은 단말기를 동시에 바꿀 때 하나만 성공한다는 것을 실험으로 증명한다.

**Architecture:** `apps/api`는 ESM Nest.js 12 앱이고 MikroORM 7(MySQL 8.4)을 쓴다. 상태를 바꾸는 길은 `TransitionService` 하나뿐이다. 이 서비스가 한 트랜잭션 안에서 전이 규칙 확인(순수 함수), 상태 변경, 이력 기록을 처리한다. 동시 수정은 `version` 컬럼(낙관적 락)으로 막고, HTTP에서는 409로 돌려준다. 작업자는 `X-Operator` 헤더로 받는다(decisions/0001).

**Tech Stack:** Node 24, TypeScript 6.0, Nest.js 12.2 (ESM), MikroORM 7.2 (`@mikro-orm/mysql`, `@mikro-orm/decorators/legacy`, `@mikro-orm/migrations`), class-validator 0.15, Vitest 5 + unplugin-swc, supertest

---

## 사전 검증으로 확인된 사실 (2026-10-22, 임시 폴더 스파이크)

계획 작성 전에 임시 프로젝트로 직접 돌려 확인했다. 이 계획의 코드는 이 사실을 전제로 한다.

- Nest 12, MikroORM 7은 **ESM 전용**(`"type": "module"`)이다. 상대 import에는 `.js` 확장자를 붙인다.
- **Nest CLI(`nest new/generate/start`)는 쓰지 않는다.** CLI는 Node 24.15 이상이 필요한데 이 PC는 24.13.1이다. 빌드는 `tsc`, 실행은 `node dist/main.js`로 한다.
- 테스트는 **Vitest + unplugin-swc**를 쓴다. swc가 `emitDecoratorMetadata`를 처리해 Nest DI가 동작한다. TypeScript는 Nest CLI와 같은 `~6.0.2`를 쓴다(7.x 아님).
- MikroORM 7 데코레이터는 `@mikro-orm/decorators/legacy`에서 가져오고, 설정에 `metadataProvider: ReflectMetadataProvider`를 넣는다.
- `em.create()` 타입이 엄격해서 기본값이 있는 속성(`version`, `status` 등)은 `[OptionalProps]`에 넣어야 한다. 넣지 않으면 TS2345 오류가 난다.
- `em.transactional`, `em.lock(entity, LockMode.OPTIMISTIC, expectedVersion)`, `OptimisticLockError`, `orm.schema.refresh()`, `orm.migrator.create()/up()`이 동작한다.
  - 동시 변경 10건 중 정확히 1건만 성공했다.
- 마이그레이션은 프로그램으로 실행한다. `create`는 `src/migrations/*.ts`를 만들고, `up`은 빌드된 `dist/migrations/*.js`를 실행한다.
- 이 PC에서는 `npm install`이 패키지 묶음 하나에 약 5분 걸린다. 의존성은 Task 1에서 한 번에 설치한다.

## 범위 조정

- 설계안 F1의 **엑셀 일괄 등록은 Day 3(F6 박스 일괄 스캔)으로 옮긴다**. 둘 다 "대량 처리 + 행별 결과"라는 같은 문제라서 한 번에 설계하는 편이 낫다. Task 9에서 decisions/0005로 기록한다.
- `ALLOCATED`(가맹점 배정) 전이는 Day 1에서는 가맹점 없이 사유만 받는다. 가맹점 연결은 출고·배송을 만드는 Day 2~3에 추가한다.

## 파일 구조

```
terminal-ops/
├─ .env.example / .env                MYSQL_TEST_DATABASE, API_PORT 추가
├─ docker-compose.yml                 init 스크립트 마운트 추가
├─ infra/mysql/init/01-test-db.sql    테스트 DB 생성 + 권한
└─ apps/api/
   ├─ package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts
   ├─ src/
   │  ├─ main.ts                      서버 시작
   │  ├─ app.module.ts                루트 모듈 (ORM, 전역 파이프·필터)
   │  ├─ config/env.ts                .env 로드, 설정값
   │  ├─ mikro-orm.config.ts          ORM 설정 (앱·스크립트 공용)
   │  ├─ entities.ts                  엔티티 목록 한 곳
   │  ├─ db/migrate.ts                마이그레이션 create/up/check
   │  ├─ db/seed.ts                   기준 데이터 시드 실행
   │  ├─ db/seed-reference.ts         모델 3종 + 검수 항목 (멱등)
   │  ├─ migrations/                  생성된 마이그레이션
   │  ├─ common/operator.decorator.ts X-Operator 헤더 → 작업자
   │  ├─ common/domain-errors.ts      InvalidTransitionError
   │  ├─ common/domain-exception.filter.ts  409/422 매핑
   │  ├─ health/health.controller.ts
   │  ├─ terminal/
   │  │  ├─ terminal-status.ts        상태·전이 출처 enum
   │  │  ├─ transition-rules.ts       전이 규칙 (순수 함수)
   │  │  ├─ terminal-model.entity.ts
   │  │  ├─ terminal.entity.ts
   │  │  ├─ terminal-status-history.entity.ts
   │  │  ├─ terminal.service.ts       등록·조회·이력
   │  │  ├─ transition.service.ts     유일한 상태 변경 경로
   │  │  ├─ terminal.views.ts         응답 형태 변환
   │  │  ├─ terminal.controller.ts
   │  │  ├─ terminal.module.ts
   │  │  └─ dto/register-terminal.dto.ts, list-terminals.query.ts, transition.dto.ts
   │  └─ inspection/
   │     ├─ inspection-item.entity.ts
   │     ├─ inspection.entities.ts    Inspection + InspectionResult (순환 참조라 한 파일)
   │     ├─ inspection.service.ts
   │     ├─ inspection.controller.ts
   │     ├─ inspection.module.ts
   │     └─ dto/inspect.dto.ts
   └─ test/
      ├─ helpers/test-app.ts
      ├─ unit/transition-rules.spec.ts
      ├─ health.e2e.spec.ts
      ├─ terminal-model.e2e.spec.ts
      ├─ terminal.e2e.spec.ts
      ├─ transition.e2e.spec.ts
      ├─ terminal-concurrency.e2e.spec.ts
      └─ inspection.e2e.spec.ts
```

명령은 별도 표시가 없으면 `terminal-ops/apps/api`에서 실행한다. Docker 명령이 PATH에 없으면 `"/c/Program Files/Docker/Docker/resources/bin/docker.exe"`를 쓴다.

---

### Task 1: 테스트 DB와 API 골격 (health)

**Files:**
- Create: `infra/mysql/init/01-test-db.sql`
- Modify: `docker-compose.yml`, `.env.example`, `.env`
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/tsconfig.build.json`, `apps/api/vitest.config.ts`
- Create: `apps/api/src/config/env.ts`, `apps/api/src/health/health.controller.ts`, `apps/api/src/app.module.ts`, `apps/api/src/main.ts`
- Test: `apps/api/test/health.e2e.spec.ts`
- Record: `docs/decisions/0002-esm-vitest-tsc-빌드.md`, `docs/troubleshooting/0002-em-create-optionalprops-타입오류.md`

- [ ] **Step 1: 테스트 DB 생성 스크립트와 compose 마운트**

`infra/mysql/init/01-test-db.sql`:
```sql
-- 볼륨을 처음 만들 때만 실행된다. 이미 만든 볼륨에는 Step 2의 명령으로 직접 적용한다.
CREATE DATABASE IF NOT EXISTS terminal_ops_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
GRANT ALL PRIVILEGES ON terminal_ops_test.* TO 'terminal_ops'@'%';
FLUSH PRIVILEGES;
```

`docker-compose.yml`의 mysql `volumes`를 다음으로 바꾼다:
```yaml
    volumes:
      - mysql-data:/var/lib/mysql
      - ./infra/mysql/init:/docker-entrypoint-initdb.d:ro
```

`.env.example`과 `.env` 끝에 추가한다(두 파일 모두):
```
MYSQL_TEST_DATABASE=terminal_ops_test
API_PORT=3000
```

- [ ] **Step 2: 이미 떠 있는 MySQL에 테스트 DB 적용**

Run (terminal-ops 루트):
```bash
MSYS_NO_PATHCONV=1 docker exec -i terminal-ops-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"' < infra/mysql/init/01-test-db.sql
MSYS_NO_PATHCONV=1 docker exec terminal-ops-mysql sh -c 'mysql -uterminal_ops -p"$MYSQL_PASSWORD" -e "show databases"'
```
Expected: 목록에 `terminal_ops`, `terminal_ops_test`가 둘 다 보인다.

- [ ] **Step 3: package.json, tsconfig, vitest 설정**

`apps/api/package.json`:
```json
{
  "name": "@terminal-ops/api",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:migration:create": "npm run build && node dist/db/migrate.js create",
    "db:migrate": "npm run build && node dist/db/migrate.js up",
    "db:migration:check": "npm run build && node dist/db/migrate.js check",
    "db:seed": "npm run build && node dist/db/seed.js"
  }
}
```

`apps/api/tsconfig.json`:
```json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2023",
    "strict": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "sourceMap": true,
    "outDir": "dist",
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`apps/api/tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": "src" },
  "include": ["src"]
}
```

`apps/api/vitest.config.ts`:
```ts
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    // e2e 테스트가 같은 테스트 DB를 쓰므로 파일 단위 병렬 실행을 끈다.
    fileParallelism: false,
    env: { NODE_ENV: 'test' },
  },
  // swc가 데코레이터 메타데이터를 만들어야 Nest DI가 동작한다.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
```

- [ ] **Step 4: 의존성 설치 (약 5~10분, 백그라운드로 실행)**

Run:
```bash
npm i @nestjs/common@12.2.0 @nestjs/core@12.2.0 @nestjs/platform-express@12.2.0 reflect-metadata@0.2.2 rxjs@7.8.2 @mikro-orm/core@7.2.5 @mikro-orm/mysql@7.2.5 @mikro-orm/nestjs@7.1.0 @mikro-orm/decorators@7.2.5 @mikro-orm/migrations@7.2.5 class-validator@0.15.1 class-transformer@0.5.1
npm i -D typescript@~6.0.2 @types/node@24 vitest@5.0.5 unplugin-swc@2.0.0 @swc/core@1.16.18 @nestjs/testing@12.2.0 supertest@7.3.1 @types/supertest@7.2.1 @types/express@5.0.6
```
Expected: 두 명령 모두 exit 0. `npm ls --depth=0`에 위 패키지가 모두 보인다.

- [ ] **Step 5: 실패하는 health 테스트 작성**

`apps/api/test/health.e2e.spec.ts`:
```ts
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

describe('GET /health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('returns ok', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 6: 실패 확인**

Run: `npx vitest run test/health.e2e.spec.ts`
Expected: FAIL, `Cannot find module '../src/app.module.js'` 또는 그와 같은 import 오류

- [ ] **Step 7: 최소 구현**

`apps/api/src/config/env.ts`:
```ts
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// 스크립트·테스트는 apps/api에서 실행한다. 저장소 루트의 .env를 읽는다.
const envFile = resolve(process.cwd(), '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const env = {
  port: Number(process.env.API_PORT ?? 3000),
};
```

`apps/api/src/health/health.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok' };
  }
}
```

`apps/api/src/app.module.ts`:
```ts
import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { HealthController } from './health/health.controller.js';

@Module({
  controllers: [HealthController],
  providers: [
    // main.ts의 useGlobalPipes는 테스트 앱에 적용되지 않는다. 모듈 provider로 등록해 테스트에서도 같게 동작시킨다.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
  ],
})
export class AppModule {}
```

`apps/api/src/main.ts`:
```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { env } from './config/env.js';

const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(env.port);
console.log(`terminal-ops api listening on http://localhost:${env.port}`);
```

- [ ] **Step 8: 테스트·타입체크·빌드 통과 확인**

Run: `npx vitest run test/health.e2e.spec.ts && npm run typecheck && npm run build`
Expected: `1 passed`, typecheck/build 출력 없음(exit 0)

- [ ] **Step 9: 실제 서버로 확인**

Run: `node dist/main.js` (백그라운드) → `curl -s http://localhost:3000/health` → 프로세스 종료
Expected: `{"status":"ok"}`

- [ ] **Step 10: 기록**

`docs/decisions/0002-esm-vitest-tsc-빌드.md` — 상황: Nest 12·MikroORM 7은 ESM 전용이고, Nest CLI는 Node 24.15 이상이 필요한데 이 PC는 24.13.1. 선택지:
1. CommonJS + Jest: require(esm)에 의존하고, Jest가 ESM 패키지를 불러오는 데 제약이 있다.
2. ESM + Vitest + tsc 빌드: Nest가 ESM 프로젝트의 기본으로 권장한다.
3. Node 업그레이드 후 Nest CLI 사용: 설치 작업이 늘어나고 이점이 적다.

결정: 2. 대가: `nest generate`를 못 쓰니 파일을 직접 만든다. 다시 볼 조건: Node를 24.15 이상으로 올리면 CLI 사용을 검토한다.

`docs/troubleshooting/0002-em-create-optionalprops-타입오류.md` — 스파이크에서 겪은 일. 증상: `em.create(Terminal, { serialNo })`에서 TS2345 "Property 'version' is missing". 원인: MikroORM 7의 `em.create`는 `!`로 선언한 속성을 필수로 본다. 해결: 기본값이 있는 속성을 `[OptionalProps]?: 'status' | 'version'`에 넣는다. 덧붙일 점: 런타임 테스트는 통과했다. swc는 타입을 검사하지 않으므로 **`npm run typecheck`를 테스트와 따로 돌려야** 한다.

`docs/devlog/<오늘>.md`에 Task 1 항목(한 일, 커밋 해시는 커밋 후 채움, 다음 할 일)을 덧붙인다. `docs/study/backlog.md`에 추가:
```
- [ ] ESM에서 import 경로에 .js를 붙이는 이유 (decisions/0002)
- [ ] Nest APP_PIPE/APP_FILTER provider vs app.useGlobalPipes 차이 (app.module.ts)
```

- [ ] **Step 11: 커밋**

`apps/api/.gitignore`가 따로 필요 없도록 루트 `.gitignore`에 `node_modules/`, `dist/`가 이미 있는지 확인한다.
```bash
git add infra docker-compose.yml .env.example apps/api docs
git commit -m "feat(infra): ESM Nest 12 API 골격과 테스트 DB" -m "Refs: docs/decisions/0002-esm-vitest-tsc-빌드.md, docs/troubleshooting/0002-em-create-optionalprops-타입오류.md"
```
커밋 해시는 커밋 뒤에야 알 수 있으므로, 다음 Task의 devlog 항목에 "이전 Task 커밋: <해시>"로 적는다(amend 하지 않는다). 이 규칙은 모든 Task에 같다.

---

### Task 2: MikroORM 연결, 단말기 모델, 기준 데이터 시드, 첫 마이그레이션

**Files:**
- Modify: `apps/api/src/config/env.ts`, `apps/api/src/app.module.ts`
- Create: `apps/api/src/terminal/terminal-model.entity.ts`, `apps/api/src/entities.ts`, `apps/api/src/mikro-orm.config.ts`
- Create: `apps/api/src/db/seed-reference.ts`, `apps/api/src/db/seed.ts`, `apps/api/src/db/migrate.ts`
- Create: `apps/api/test/helpers/test-app.ts`
- Test: `apps/api/test/terminal-model.e2e.spec.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/helpers/test-app.ts`:
```ts
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/mysql';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { seedReference } from '../../src/db/seed-reference.js';

export interface TestApp {
  app: INestApplication;
  orm: MikroORM;
  http: () => ReturnType<typeof request>;
}

export async function createTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  const orm = app.get(MikroORM);
  return { app, orm, http: () => request(app.getHttpServer()) };
}

/** 테스트 DB 스키마를 엔티티 기준으로 다시 만들고 기준 데이터를 넣는다. */
export async function resetDatabase(orm: MikroORM): Promise<void> {
  await orm.schema.refresh();
  await seedReference(orm.em.fork());
}
```

`apps/api/test/terminal-model.e2e.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TerminalModel } from '../src/terminal/terminal-model.entity.js';
import { seedReference } from '../src/db/seed-reference.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('기준 데이터: 단말기 모델', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('SN-100/200/300 세 모델이 들어가고, SN-200만 재검수 필수다', async () => {
    const models = await t.orm.em.fork().find(TerminalModel, {}, { orderBy: { code: 'asc' } });
    expect(models.map((m) => [m.code, m.requiresReinspection])).toEqual([
      ['SN-100', false],
      ['SN-200', true],
      ['SN-300', false],
    ]);
  });

  it('시드를 두 번 돌려도 중복되지 않는다', async () => {
    await seedReference(t.orm.em.fork());
    expect(await t.orm.em.fork().count(TerminalModel)).toBe(3);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/terminal-model.e2e.spec.ts`
Expected: FAIL, `seed-reference.js` 또는 `terminal-model.entity.js` import 오류

- [ ] **Step 3: 설정과 엔티티 구현**

`apps/api/src/config/env.ts` 전체를 다음으로 바꾼다:
```ts
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// 스크립트·테스트는 apps/api에서 실행한다. 저장소 루트의 .env를 읽는다.
const envFile = resolve(process.cwd(), '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`환경변수 ${name}가 없습니다. 저장소 루트 .env를 확인하세요.`);
  return value;
}

const isTest = process.env.NODE_ENV === 'test';

export const env = {
  port: Number(process.env.API_PORT ?? 3000),
  mysql: {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: required('MYSQL_USER'),
    password: required('MYSQL_PASSWORD'),
    dbName: isTest ? required('MYSQL_TEST_DATABASE') : required('MYSQL_DATABASE'),
  },
};
```

`apps/api/src/terminal/terminal-model.entity.ts`:
```ts
import { OptionalProps } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'terminal_model' })
export class TerminalModel {
  [OptionalProps]?: 'requiresReinspection';

  @PrimaryKey()
  id!: number;

  @Property({ unique: true, length: 20 })
  code!: string;

  @Property({ length: 50 })
  name!: string;

  /** 회수된 단말기를 재검수 없이 재고로 돌릴 수 없는 모델인지 */
  @Property()
  requiresReinspection: boolean = false;
}
```

`apps/api/src/entities.ts`:
```ts
import { TerminalModel } from './terminal/terminal-model.entity.js';

/** 앱·마이그레이션·시드가 함께 쓰는 엔티티 목록. 엔티티를 추가하면 여기에도 추가한다. */
export const ENTITIES = [TerminalModel];
```

`apps/api/src/mikro-orm.config.ts`:
```ts
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
```

`apps/api/src/db/seed-reference.ts`:
```ts
import type { EntityManager } from '@mikro-orm/mysql';
import { TerminalModel } from '../terminal/terminal-model.entity.js';

interface ModelSeed {
  code: string;
  name: string;
  requiresReinspection: boolean;
}

export const MODEL_SEEDS: ModelSeed[] = [
  { code: 'SN-100', name: '유선 카운터형', requiresReinspection: false },
  { code: 'SN-200', name: '무선 LTE형', requiresReinspection: true },
  { code: 'SN-300', name: '테이블오더 태블릿형', requiresReinspection: false },
];

/** 기준 데이터를 넣는다. 이미 있는 행은 건너뛰므로 여러 번 실행해도 된다. */
export async function seedReference(em: EntityManager): Promise<void> {
  for (const seed of MODEL_SEEDS) {
    const existing = await em.findOne(TerminalModel, { code: seed.code });
    if (!existing) em.create(TerminalModel, seed);
  }
  await em.flush();
}
```

`apps/api/src/db/seed.ts`:
```ts
import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/mysql';
import config from '../mikro-orm.config.js';
import { seedReference } from './seed-reference.js';

const orm = await MikroORM.init(config);
try {
  await seedReference(orm.em.fork());
  console.log('기준 데이터 시드 완료');
} finally {
  await orm.close(true);
}
```

`apps/api/src/db/migrate.ts`:
```ts
import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/mysql';
import config from '../mikro-orm.config.js';

const command = process.argv[2];
const orm = await MikroORM.init(config);
try {
  if (command === 'create') {
    const result = await orm.migrator.create();
    console.log(result.fileName ? `생성: ${result.fileName}` : '변경 없음: 마이그레이션을 만들지 않았습니다.');
  } else if (command === 'up') {
    const done = await orm.migrator.up();
    console.log(`적용: ${done.map((m) => m.name).join(', ') || '없음'}`);
  } else if (command === 'check') {
    const needed = await orm.migrator.checkSchema();
    console.log(needed ? '엔티티와 마이그레이션이 다릅니다. db:migration:create가 필요합니다.' : '최신 상태');
    if (needed) process.exitCode = 1;
  } else {
    console.error('사용법: node dist/db/migrate.js <create|up|check>');
    process.exitCode = 1;
  }
} finally {
  await orm.close(true);
}
```

`apps/api/src/app.module.ts` 전체를 다음으로 바꾼다:
```ts
import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import ormConfig from './mikro-orm.config.js';
import { HealthController } from './health/health.controller.js';

@Module({
  // forRoot가 요청마다 EntityManager를 fork하는 RequestContext 미들웨어를 자동 등록한다.
  imports: [MikroOrmModule.forRoot(ormConfig)],
  controllers: [HealthController],
  providers: [
    // main.ts의 useGlobalPipes는 테스트 앱에 적용되지 않는다. 모듈 provider로 등록해 테스트에서도 같게 동작시킨다.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
  ],
})
export class AppModule {}
```

- [ ] **Step 4: 테스트 통과 확인 (health 포함 전체)**

Run: `npx vitest run && npm run typecheck`
Expected: 테스트 파일 2개, `3 passed`, typecheck exit 0

- [ ] **Step 5: 첫 마이그레이션 생성·적용·시드 (개발 DB)**

Run:
```bash
npm run db:migration:create
npm run db:migrate
npm run db:seed
npm run db:migration:check
```
Expected:
- `생성: Migration<시각>.ts`
- `적용: Migration<시각>`
- `기준 데이터 시드 완료`
- `최신 상태`

`src/migrations/`에 파일이 하나 생긴다. 생성된 SQL에 `terminal_model` 테이블과 `code` unique가 있는지 열어서 확인한다.

- [ ] **Step 6: 기록과 커밋**

devlog에 Task 2 항목을 덧붙인다. 마이그레이션 파일명과 "테스트는 마이그레이션이 아니라 `schema.refresh()`로 스키마를 만든다. 둘이 어긋나지 않는지는 `db:migration:check`로 확인한다"는 메모를 함께 적는다. backlog에 추가:
```
- [ ] MikroORM RequestContext — MikroOrmModule.forRoot가 요청마다 em을 fork하는 방식 (app.module.ts)
- [ ] 마이그레이션 vs schema.refresh — 테스트에서 refresh를 쓰는 이유와 위험 (Task 2)
```
```bash
git add apps/api docs
git commit -m "feat(F1): MikroORM 연결, 단말기 모델 기준 데이터, 첫 마이그레이션"
```

---

### Task 3: 단말기·이력 엔티티, 작업자 헤더, 등록·조회 API (F1)

**Files:**
- Create: `apps/api/src/terminal/terminal-status.ts`, `terminal.entity.ts`, `terminal-status-history.entity.ts`, `terminal.views.ts`, `terminal.service.ts`, `terminal.controller.ts`, `terminal.module.ts`
- Create: `apps/api/src/terminal/dto/register-terminal.dto.ts`, `apps/api/src/terminal/dto/list-terminals.query.ts`
- Create: `apps/api/src/common/operator.decorator.ts`, `apps/api/src/common/domain-errors.ts`, `apps/api/src/common/domain-exception.filter.ts`
- Modify: `apps/api/src/entities.ts`, `apps/api/src/app.module.ts`
- Test: `apps/api/test/terminal.e2e.spec.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/terminal.e2e.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'kim' };

describe('단말기 등록·조회 (F1)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('등록하면 RECEIVED, version 1로 만들어진다', async () => {
    const res = await t.http().post('/terminals').set(OP).send({ serialNo: 'T-0001', modelCode: 'SN-100' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ serialNo: 'T-0001', modelCode: 'SN-100', status: 'RECEIVED', version: 1 });
  });

  it('등록 이력이 작업자와 함께 남는다', async () => {
    const res = await t.http().get('/terminals/T-0001/history');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: 'RECEIVED', source: 'MANUAL', actor: 'kim', reason: '신규 등록' }),
    ]);
  });

  it('한글 작업자 이름은 URL 인코딩해서 보낸다', async () => {
    const res = await t
      .http()
      .post('/terminals')
      .set({ 'X-Operator': encodeURIComponent('김운영') })
      .send({ serialNo: 'T-0002', modelCode: 'SN-200' });
    expect(res.status).toBe(201);
    const history = await t.http().get('/terminals/T-0002/history');
    expect(history.body[0].actor).toBe('김운영');
  });

  it('X-Operator가 없으면 400', async () => {
    const res = await t.http().post('/terminals').send({ serialNo: 'T-0003', modelCode: 'SN-100' });
    expect(res.status).toBe(400);
  });

  it('system: 으로 시작하는 작업자는 사람이 쓸 수 없다', async () => {
    const res = await t.http().post('/terminals').set({ 'X-Operator': 'system:batch' }).send({ serialNo: 'T-0003', modelCode: 'SN-100' });
    expect(res.status).toBe(400);
  });

  it('같은 시리얼을 다시 등록하면 409 DUPLICATE', async () => {
    const res = await t.http().post('/terminals').set(OP).send({ serialNo: 'T-0001', modelCode: 'SN-100' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE');
  });

  it('없는 모델이면 404', async () => {
    const res = await t.http().post('/terminals').set(OP).send({ serialNo: 'T-0009', modelCode: 'SN-999' });
    expect(res.status).toBe(404);
  });

  it('시리얼 형식이 틀리면 400', async () => {
    const res = await t.http().post('/terminals').set(OP).send({ serialNo: 'bad serial', modelCode: 'SN-100' });
    expect(res.status).toBe(400);
  });

  it('상태·모델·시리얼 앞부분으로 검색하고 페이지를 나눈다', async () => {
    const byModel = await t.http().get('/terminals').query({ modelCode: 'SN-200' });
    expect(byModel.body.total).toBe(1);
    expect(byModel.body.items[0].serialNo).toBe('T-0002');

    const byPrefix = await t.http().get('/terminals').query({ q: 'T-000', size: 1, page: 2 });
    expect(byPrefix.body).toMatchObject({ total: 2, page: 2, size: 1 });
    expect(byPrefix.body.items).toHaveLength(1);

    const byStatus = await t.http().get('/terminals').query({ status: 'IN_STOCK' });
    expect(byStatus.body.total).toBe(0);
  });

  it('검색어의 % 는 와일드카드로 쓰이지 않는다', async () => {
    const res = await t.http().get('/terminals').query({ q: '%' });
    expect(res.body.total).toBe(0);
  });

  it('단건 조회, 없으면 404', async () => {
    expect((await t.http().get('/terminals/T-0001')).body.serialNo).toBe('T-0001');
    expect((await t.http().get('/terminals/NOPE-1')).status).toBe(404);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/terminal.e2e.spec.ts`
Expected: FAIL, `/terminals` 요청이 404(컨트롤러 없음)

- [ ] **Step 3: 상태 enum과 엔티티**

`apps/api/src/terminal/terminal-status.ts`:
```ts
export enum TerminalStatus {
  RECEIVED = 'RECEIVED', // 입고
  INSPECTED = 'INSPECTED', // 검수 합격
  DEFECTIVE = 'DEFECTIVE', // 불량
  IN_STOCK = 'IN_STOCK', // 재고
  ALLOCATED = 'ALLOCATED', // 가맹점 배정
  SHIPPED = 'SHIPPED', // 출고(배송 중)
  DELIVERED = 'DELIVERED', // 배송 완료
  IN_SERVICE = 'IN_SERVICE', // 운영 중
  RETURN_REQUESTED = 'RETURN_REQUESTED', // 회수 요청
  RETURNING = 'RETURNING', // 회수 중
  RETURNED = 'RETURNED', // 회수 입고
  DISPOSED = 'DISPOSED', // 폐기
}

/** 상태를 바꾼 경로. 이후 Day에서 BATCH, SCAN, IMPORT 등을 추가한다. */
export enum TransitionSource {
  MANUAL = 'MANUAL',
  INSPECTION = 'INSPECTION',
}
```

`apps/api/src/terminal/terminal.entity.ts`:
```ts
import { OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, Enum, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TerminalModel } from './terminal-model.entity.js';
import { TerminalStatus } from './terminal-status.js';

@Entity({ tableName: 'terminal' })
@Index({ properties: ['status'] })
export class Terminal {
  [OptionalProps]?: 'status' | 'version' | 'createdAt' | 'updatedAt';

  @PrimaryKey()
  id!: number;

  @Property({ unique: true, length: 32 })
  serialNo!: string;

  // Rel<>: ESM 순환 import에서 데코레이터 메타데이터가 클래스를 너무 일찍 참조하지 않게 한다.
  @ManyToOne(() => TerminalModel)
  model!: Rel<TerminalModel>;

  @Enum({ items: () => TerminalStatus })
  status: TerminalStatus = TerminalStatus.RECEIVED;

  /** 낙관적 락. flush할 때 WHERE version = ? 로 확인하고 1 올린다. */
  @Property({ version: true })
  version!: number;

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
```

`apps/api/src/terminal/terminal-status-history.entity.ts`:
```ts
import { OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, Enum, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { Terminal } from './terminal.entity.js';
import { TerminalStatus, TransitionSource } from './terminal-status.js';

/** 상태 변경 이력. 추가만 하고 수정·삭제하지 않는다. */
@Entity({ tableName: 'terminal_status_history' })
@Index({ properties: ['terminal', 'occurredAt'] })
export class TerminalStatusHistory {
  [OptionalProps]?: 'occurredAt';

  @PrimaryKey()
  id!: number;

  @ManyToOne(() => Terminal)
  terminal!: Rel<Terminal>;

  /** 등록 이력은 이전 상태가 없어 null */
  @Enum({ items: () => TerminalStatus, nullable: true })
  fromStatus?: TerminalStatus | null;

  @Enum({ items: () => TerminalStatus })
  toStatus!: TerminalStatus;

  @Enum({ items: () => TransitionSource })
  source!: TransitionSource;

  @Property({ length: 50 })
  actor!: string;

  @Property({ length: 200 })
  reason!: string;

  @Property()
  occurredAt: Date = new Date();
}
```

`apps/api/src/entities.ts`:
```ts
import { TerminalModel } from './terminal/terminal-model.entity.js';
import { Terminal } from './terminal/terminal.entity.js';
import { TerminalStatusHistory } from './terminal/terminal-status-history.entity.js';

/** 앱·마이그레이션·시드가 함께 쓰는 엔티티 목록. 엔티티를 추가하면 여기에도 추가한다. */
export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory];
```

- [ ] **Step 4: 공통 — 작업자 헤더, 도메인 오류, 예외 필터**

`apps/api/src/common/operator.decorator.ts`:
```ts
import { BadRequestException, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export const OPERATOR_HEADER = 'x-operator';
const MESSAGE = 'X-Operator 헤더(작업자 이름, 50자 이하)가 필요합니다. 한글은 URL 인코딩해서 보내세요.';

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return '';
  }
}

/** 요청한 작업자 이름. 인증 대신 헤더로 받는다(decisions/0001). `system:`은 시스템 작업 전용이라 거절한다. */
export const Operator = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const raw = ctx.switchToHttp().getRequest<Request>().header(OPERATOR_HEADER);
  const name = raw ? decode(raw) : '';
  if (!name || name.length > 50 || name.startsWith('system:')) throw new BadRequestException(MESSAGE);
  return name;
});
```

`apps/api/src/common/domain-errors.ts`:
```ts
/** 허용되지 않은 상태 전이. HTTP 422로 바뀐다. */
export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransitionError';
  }
}
```

`apps/api/src/common/domain-exception.filter.ts`:
```ts
import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { OptimisticLockError, UniqueConstraintViolationException } from '@mikro-orm/mysql';
import type { Response } from 'express';
import { InvalidTransitionError } from './domain-errors.js';

/** ORM·도메인 오류를 HTTP 응답으로 바꾼다. 응답의 code로 클라이언트가 원인을 구분한다. */
@Catch(OptimisticLockError, UniqueConstraintViolationException, InvalidTransitionError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(error: Error, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (error instanceof OptimisticLockError) {
      return res.status(409).json({
        statusCode: 409,
        code: 'VERSION_CONFLICT',
        message: '다른 작업이 먼저 이 단말기를 변경했습니다. 다시 조회한 뒤 시도하세요.',
      });
    }
    if (error instanceof UniqueConstraintViolationException) {
      return res.status(409).json({ statusCode: 409, code: 'DUPLICATE', message: '이미 존재하는 값입니다.' });
    }
    return res.status(422).json({ statusCode: 422, code: 'INVALID_TRANSITION', message: error.message });
  }
}
```

- [ ] **Step 5: DTO, 응답 변환, 서비스, 컨트롤러, 모듈**

`apps/api/src/terminal/dto/register-terminal.dto.ts`:
```ts
import { IsString, Matches } from 'class-validator';

export class RegisterTerminalDto {
  @Matches(/^[A-Z0-9-]{4,32}$/, { message: 'serialNo는 대문자·숫자·하이픈 4~32자입니다.' })
  serialNo!: string;

  @IsString()
  modelCode!: string;
}
```

`apps/api/src/terminal/dto/list-terminals.query.ts`:
```ts
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { TerminalStatus } from '../terminal-status.js';

export class ListTerminalsQuery {
  @IsOptional()
  @IsEnum(TerminalStatus)
  status?: TerminalStatus;

  @IsOptional()
  @IsString()
  modelCode?: string;

  /** 시리얼 앞부분 */
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size: number = 20;
}
```

`apps/api/src/terminal/terminal.views.ts`:
```ts
import type { Terminal } from './terminal.entity.js';
import type { TerminalStatusHistory } from './terminal-status-history.entity.js';

/** 엔티티를 그대로 내보내지 않고 응답 형태를 여기서 고정한다. model이 populate돼 있어야 한다. */
export function toTerminalView(t: Terminal) {
  return {
    serialNo: t.serialNo,
    modelCode: t.model.code,
    status: t.status,
    version: t.version,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function toHistoryView(h: TerminalStatusHistory) {
  return {
    fromStatus: h.fromStatus ?? null,
    toStatus: h.toStatus,
    source: h.source,
    actor: h.actor,
    reason: h.reason,
    occurredAt: h.occurredAt.toISOString(),
  };
}
```

`apps/api/src/terminal/terminal.service.ts`:
```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { RegisterTerminalDto } from './dto/register-terminal.dto.js';
import type { ListTerminalsQuery } from './dto/list-terminals.query.js';
import { TerminalModel } from './terminal-model.entity.js';
import { Terminal } from './terminal.entity.js';
import { TerminalStatusHistory } from './terminal-status-history.entity.js';
import { TerminalStatus, TransitionSource } from './terminal-status.js';

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

@Injectable()
export class TerminalService {
  constructor(private readonly em: EntityManager) {}

  /** 단말기와 첫 이력(RECEIVED)을 한 트랜잭션으로 만든다. */
  async register(dto: RegisterTerminalDto, actor: string): Promise<Terminal> {
    return this.em.transactional(async (tx) => {
      const model = await tx.findOne(TerminalModel, { code: dto.modelCode });
      if (!model) throw new NotFoundException(`단말기 모델 ${dto.modelCode}이(가) 없습니다.`);
      const terminal = tx.create(Terminal, { serialNo: dto.serialNo, model });
      tx.create(TerminalStatusHistory, {
        terminal,
        fromStatus: null,
        toStatus: TerminalStatus.RECEIVED,
        source: TransitionSource.MANUAL,
        actor,
        reason: '신규 등록',
      });
      return terminal;
    });
  }

  async list(query: ListTerminalsQuery) {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.modelCode ? { model: { code: query.modelCode } } : {}),
      ...(query.q ? { serialNo: { $like: `${escapeLike(query.q)}%` } } : {}),
    };
    const [items, total] = await this.em.findAndCount(Terminal, where, {
      populate: ['model'],
      orderBy: { id: 'desc' },
      limit: query.size,
      offset: (query.page - 1) * query.size,
    });
    return { items, total, page: query.page, size: query.size };
  }

  async getBySerial(serialNo: string): Promise<Terminal> {
    const terminal = await this.em.findOne(Terminal, { serialNo }, { populate: ['model'] });
    if (!terminal) throw new NotFoundException(`단말기 ${serialNo}이(가) 없습니다.`);
    return terminal;
  }

  async history(serialNo: string): Promise<TerminalStatusHistory[]> {
    const terminal = await this.getBySerial(serialNo);
    return this.em.find(TerminalStatusHistory, { terminal }, { orderBy: { id: 'asc' } });
  }
}
```

`apps/api/src/terminal/terminal.controller.ts`:
```ts
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { RegisterTerminalDto } from './dto/register-terminal.dto.js';
import { ListTerminalsQuery } from './dto/list-terminals.query.js';
import { TerminalService } from './terminal.service.js';
import { toHistoryView, toTerminalView } from './terminal.views.js';

@Controller('terminals')
export class TerminalController {
  constructor(private readonly terminals: TerminalService) {}

  @Post()
  async register(@Body() dto: RegisterTerminalDto, @Operator() actor: string) {
    return toTerminalView(await this.terminals.register(dto, actor));
  }

  @Get()
  async list(@Query() query: ListTerminalsQuery) {
    const result = await this.terminals.list(query);
    return { ...result, items: result.items.map(toTerminalView) };
  }

  @Get(':serialNo')
  async get(@Param('serialNo') serialNo: string) {
    return toTerminalView(await this.terminals.getBySerial(serialNo));
  }

  @Get(':serialNo/history')
  async history(@Param('serialNo') serialNo: string) {
    return (await this.terminals.history(serialNo)).map(toHistoryView);
  }
}
```

`apps/api/src/terminal/terminal.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { TerminalController } from './terminal.controller.js';
import { TerminalService } from './terminal.service.js';

@Module({
  controllers: [TerminalController],
  providers: [TerminalService],
  exports: [TerminalService],
})
export class TerminalModule {}
```

`apps/api/src/app.module.ts` 전체를 다음으로 바꾼다:
```ts
import { Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import ormConfig from './mikro-orm.config.js';
import { HealthController } from './health/health.controller.js';
import { DomainExceptionFilter } from './common/domain-exception.filter.js';
import { TerminalModule } from './terminal/terminal.module.js';

@Module({
  // forRoot가 요청마다 EntityManager를 fork하는 RequestContext 미들웨어를 자동 등록한다.
  imports: [MikroOrmModule.forRoot(ormConfig), TerminalModule],
  controllers: [HealthController],
  providers: [
    // main.ts의 useGlobalPipes/Filters는 테스트 앱에 적용되지 않는다. 모듈 provider로 등록해 테스트에서도 같게 동작시킨다.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {}
```

- [ ] **Step 6: 통과 확인**

Run: `npx vitest run && npm run typecheck`
Expected: 모든 테스트 통과(`terminal.e2e` 11개 포함), typecheck exit 0.
- `populate: ['model']`나 `findAndCount`의 `where` 타입에서 오류가 나면, 원인과 고친 방법을 troubleshooting에 남긴다.
- 중복 등록이 409가 아니라 500으로 나오면 MySQL 드라이버가 `UniqueConstraintViolationException`으로 감싸지 않은 것이다. 실제 예외 클래스명을 로그로 확인해 기록한 뒤 필터를 고친다.

- [ ] **Step 7: 마이그레이션**

Run: `npm run db:migration:create && npm run db:migrate && npm run db:migration:check`
Expected: 새 마이그레이션에 `terminal`, `terminal_status_history` 테이블과 `serial_no` unique, `status` 인덱스, `(terminal_id, occurred_at)` 인덱스가 보인다. 마지막 줄은 `최신 상태`.

- [ ] **Step 8: 기록과 커밋**

devlog에 Task 3 항목을 덧붙인다. backlog에 추가:
```
- [ ] Rel<T>와 ESM 순환 import — emitDecoratorMetadata가 클래스를 너무 일찍 참조하는 문제 (terminal.entity.ts)
- [ ] em.transactional 안에서 create만 하고 flush를 안 부르는데 저장되는 이유 (terminal.service.ts register)
- [ ] LIKE 검색어 이스케이프 (terminal.service.ts escapeLike)
```
```bash
git add apps/api docs
git commit -m "feat(F1): 단말기 등록·조회 API와 작업자 헤더"
```

---

### Task 4: 전이 규칙 (순수 함수) (F2)

**Files:**
- Create: `apps/api/src/terminal/transition-rules.ts`
- Test: `apps/api/test/unit/transition-rules.spec.ts`
- Record: `docs/decisions/0003-전이-규칙은-TS-표로.md`

- [ ] **Step 1: 실패하는 단위 테스트 작성**

`apps/api/test/unit/transition-rules.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { checkTransition } from '../../src/terminal/transition-rules.js';
import { TerminalStatus as S, TransitionSource as Src } from '../../src/terminal/terminal-status.js';

const normal = { requiresReinspection: false };
const strict = { requiresReinspection: true };

describe('checkTransition', () => {
  it.each([
    [S.INSPECTED, S.IN_STOCK],
    [S.IN_STOCK, S.ALLOCATED],
    [S.ALLOCATED, S.IN_STOCK],
    [S.ALLOCATED, S.SHIPPED],
    [S.SHIPPED, S.DELIVERED],
    [S.DELIVERED, S.IN_SERVICE],
    [S.IN_SERVICE, S.RETURN_REQUESTED],
    [S.RETURN_REQUESTED, S.RETURNING],
    [S.RETURNING, S.RETURNED],
    [S.RETURNED, S.IN_STOCK],
    [S.DEFECTIVE, S.DISPOSED],
  ])('수동 전이 %s → %s 허용', (from, to) => {
    expect(checkTransition(from, to, Src.MANUAL, normal)).toEqual({ ok: true });
  });

  it('정의되지 않은 전이는 거절하고 이유를 준다', () => {
    const r = checkTransition(S.RECEIVED, S.SHIPPED, Src.MANUAL, normal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('RECEIVED → SHIPPED');
  });

  it('같은 상태로의 전이는 거절', () => {
    expect(checkTransition(S.IN_STOCK, S.IN_STOCK, Src.MANUAL, normal).ok).toBe(false);
  });

  it.each([
    [S.RECEIVED, S.INSPECTED],
    [S.RECEIVED, S.DEFECTIVE],
    [S.RETURNED, S.INSPECTED],
    [S.RETURNED, S.DEFECTIVE],
  ])('%s → %s 는 검수로만 가능', (from, to) => {
    expect(checkTransition(from, to, Src.MANUAL, normal).ok).toBe(false);
    expect(checkTransition(from, to, Src.INSPECTION, normal)).toEqual({ ok: true });
  });

  it('검수는 검수 전용 전이 외에는 쓸 수 없다', () => {
    expect(checkTransition(S.INSPECTED, S.IN_STOCK, Src.INSPECTION, normal).ok).toBe(false);
  });

  it('재검수 필수 모델은 회수 후 바로 재고로 못 간다', () => {
    const r = checkTransition(S.RETURNED, S.IN_STOCK, Src.MANUAL, strict);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('재검수');
  });

  it('폐기는 끝 상태다', () => {
    for (const to of Object.values(S)) {
      expect(checkTransition(S.DISPOSED, to, Src.MANUAL, normal).ok).toBe(false);
    }
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/unit/transition-rules.spec.ts`
Expected: FAIL, `transition-rules.js` import 오류

- [ ] **Step 3: 구현**

`apps/api/src/terminal/transition-rules.ts`:
```ts
import { TerminalStatus as S, TransitionSource } from './terminal-status.js';

export interface ModelPolicy {
  requiresReinspection: boolean;
}

interface TransitionRule {
  from: S;
  to: S;
  /** 이 전이를 일으킬 수 있는 경로. 없으면 INSPECTION을 뺀 모든 경로 */
  only?: TransitionSource[];
  /** 모델 정책 때문에 막히면 이유를 돌려준다 */
  blockedBy?: (policy: ModelPolicy) => string | undefined;
}

/** 단말기 상태 전이 표. 상태 변경 규칙은 여기 한 곳에만 둔다(decisions/0003). */
const RULES: TransitionRule[] = [
  { from: S.RECEIVED, to: S.INSPECTED, only: [TransitionSource.INSPECTION] },
  { from: S.RECEIVED, to: S.DEFECTIVE, only: [TransitionSource.INSPECTION] },
  { from: S.INSPECTED, to: S.IN_STOCK },
  { from: S.IN_STOCK, to: S.ALLOCATED },
  { from: S.ALLOCATED, to: S.IN_STOCK },
  { from: S.ALLOCATED, to: S.SHIPPED },
  { from: S.SHIPPED, to: S.DELIVERED },
  { from: S.DELIVERED, to: S.IN_SERVICE },
  { from: S.IN_SERVICE, to: S.RETURN_REQUESTED },
  { from: S.RETURN_REQUESTED, to: S.RETURNING },
  { from: S.RETURNING, to: S.RETURNED },
  { from: S.RETURNED, to: S.INSPECTED, only: [TransitionSource.INSPECTION] },
  { from: S.RETURNED, to: S.DEFECTIVE, only: [TransitionSource.INSPECTION] },
  {
    from: S.RETURNED,
    to: S.IN_STOCK,
    blockedBy: (p) => (p.requiresReinspection ? '재검수 필수 모델은 회수 후 검수를 거쳐야 재고로 돌릴 수 있습니다.' : undefined),
  },
  { from: S.DEFECTIVE, to: S.DISPOSED },
];

export type TransitionCheck = { ok: true } | { ok: false; reason: string };

export function checkTransition(from: S, to: S, source: TransitionSource, policy: ModelPolicy): TransitionCheck {
  const rule = RULES.find((r) => r.from === from && r.to === to);
  if (!rule) return { ok: false, reason: `허용되지 않은 전이입니다: ${from} → ${to}` };

  const allowed = rule.only ?? Object.values(TransitionSource).filter((s) => s !== TransitionSource.INSPECTION);
  if (!allowed.includes(source)) {
    return { ok: false, reason: `${from} → ${to} 는 ${allowed.join(', ')} 경로로만 바꿀 수 있습니다(요청 경로: ${source}).` };
  }

  const blocked = rule.blockedBy?.(policy);
  if (blocked) return { ok: false, reason: blocked };
  return { ok: true };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/unit/transition-rules.spec.ts && npm run typecheck`
Expected: 모든 케이스 통과, typecheck exit 0

- [ ] **Step 5: 기록과 커밋**

`docs/decisions/0003-전이-규칙은-TS-표로.md`:
- 상황: 모델마다 전이가 조금씩 다르다(SN-200 재검수 필수). 검수 전이는 검수 기능으로만 일어나야 한다.
- 선택지:
  1. YAML 파일: 이전 프로젝트에서 쓴 방식. 코드와 분리되지만 타입 검사가 없다.
  2. TS 표 + 순수 함수: 타입 검사와 단위 테스트가 쉽다.
  3. DB 테이블: 운영자가 바꿀 수 있지만 지금은 필요 없다.
- 결정: 2.
- 규칙: `only`로 전이 경로를 제한하고, `blockedBy`로 모델 정책을 적용한다. 같은 상태로의 전이는 표에 없으므로 자동으로 거절된다.
- 다시 볼 조건: 운영자가 규칙을 직접 바꿔야 하면 3.

devlog에 덧붙이고 커밋:
```bash
git add apps/api docs
git commit -m "feat(F2): 단말기 상태 전이 규칙" -m "Refs: docs/decisions/0003-전이-규칙은-TS-표로.md"
```

---

### Task 5: 전이 서비스와 API — 낙관적 락, 409/422 (F2)

**Files:**
- Create: `apps/api/src/terminal/transition.service.ts`, `apps/api/src/terminal/dto/transition.dto.ts`
- Modify: `apps/api/src/terminal/terminal.controller.ts`, `apps/api/src/terminal/terminal.module.ts`
- Test: `apps/api/test/transition.e2e.spec.ts`
- Record: `docs/decisions/0004-동시-수정은-낙관적-락과-expectedVersion.md`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/transition.e2e.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'lee' };

describe('상태 전이 API (F2)', () => {
  let t: TestApp;

  /** 테스트 준비용: 검수 기능 없이 상태를 직접 맞춘다. */
  async function forceStatus(serialNo: string, status: TerminalStatus) {
    const em = t.orm.em.fork();
    const terminal = await em.findOneOrFail(Terminal, { serialNo });
    terminal.status = status;
    await em.flush();
    return terminal.version;
  }

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await t.http().post('/terminals').set(OP).send({ serialNo: 'TR-0001', modelCode: 'SN-100' });
    await t.http().post('/terminals').set(OP).send({ serialNo: 'TR-0002', modelCode: 'SN-200' });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('허용된 전이는 200, version이 오르고 이력이 남는다', async () => {
    const version = await forceStatus('TR-0001', TerminalStatus.INSPECTED);
    const res = await t
      .http()
      .post('/terminals/TR-0001/transitions')
      .set(OP)
      .send({ to: 'IN_STOCK', reason: '검수 완료분 재고 편입', expectedVersion: version });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'IN_STOCK', version: version + 1 });

    const history = await t.http().get('/terminals/TR-0001/history');
    expect(history.body.at(-1)).toMatchObject({
      fromStatus: 'INSPECTED',
      toStatus: 'IN_STOCK',
      source: 'MANUAL',
      actor: 'lee',
      reason: '검수 완료분 재고 편입',
    });
  });

  it('expectedVersion이 현재와 다르면 409 VERSION_CONFLICT, 상태는 그대로', async () => {
    const res = await t
      .http()
      .post('/terminals/TR-0001/transitions')
      .set(OP)
      .send({ to: 'ALLOCATED', reason: '배정', expectedVersion: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    expect((await t.http().get('/terminals/TR-0001')).body.status).toBe('IN_STOCK');
  });

  it('허용되지 않은 전이는 422 INVALID_TRANSITION, 이력이 늘지 않는다', async () => {
    const before = (await t.http().get('/terminals/TR-0001/history')).body.length;
    const current = (await t.http().get('/terminals/TR-0001')).body.version;
    const res = await t
      .http()
      .post('/terminals/TR-0001/transitions')
      .set(OP)
      .send({ to: 'DISPOSED', reason: '폐기', expectedVersion: current });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_TRANSITION');
    expect((await t.http().get('/terminals/TR-0001/history')).body.length).toBe(before);
  });

  it('검수 전용 전이를 수동으로 하면 422', async () => {
    const current = (await t.http().get('/terminals/TR-0002')).body.version;
    const res = await t
      .http()
      .post('/terminals/TR-0002/transitions')
      .set(OP)
      .send({ to: 'INSPECTED', reason: '수동 합격', expectedVersion: current });
    expect(res.status).toBe(422);
  });

  it('재검수 필수 모델(SN-200)은 회수 후 바로 재고로 못 간다', async () => {
    const version = await forceStatus('TR-0002', TerminalStatus.RETURNED);
    const res = await t
      .http()
      .post('/terminals/TR-0002/transitions')
      .set(OP)
      .send({ to: 'IN_STOCK', reason: '재고 복귀', expectedVersion: version });
    expect(res.status).toBe(422);
    expect(res.body.message).toContain('재검수');
  });

  it('expectedVersion·reason이 없으면 400', async () => {
    const res = await t.http().post('/terminals/TR-0001/transitions').set(OP).send({ to: 'ALLOCATED' });
    expect(res.status).toBe(400);
  });

  it('없는 단말기는 404', async () => {
    const res = await t
      .http()
      .post('/terminals/NOPE-1/transitions')
      .set(OP)
      .send({ to: 'ALLOCATED', reason: 'x', expectedVersion: 1 });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/transition.e2e.spec.ts`
Expected: FAIL, `/terminals/:serialNo/transitions`가 404

- [ ] **Step 3: 구현**

`apps/api/src/terminal/dto/transition.dto.ts`:
```ts
import { IsEnum, IsInt, IsString, Length, Min } from 'class-validator';
import { TerminalStatus } from '../terminal-status.js';

export class TransitionDto {
  @IsEnum(TerminalStatus)
  to!: TerminalStatus;

  @IsString()
  @Length(1, 200)
  reason!: string;

  /** 화면에서 본 version. 그 사이 다른 변경이 있었으면 409 (decisions/0004) */
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
```

`apps/api/src/terminal/transition.service.ts`:
```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { InvalidTransitionError } from '../common/domain-errors.js';
import { Terminal } from './terminal.entity.js';
import { TerminalStatusHistory } from './terminal-status-history.entity.js';
import { TerminalStatus, TransitionSource } from './terminal-status.js';
import { checkTransition } from './transition-rules.js';

export interface TransitionCommand {
  serialNo: string;
  to: TerminalStatus;
  reason: string;
  actor: string;
  source: TransitionSource;
  /** 사람이 화면을 보고 바꿀 때는 필수. 시스템 작업은 생략할 수 있다(flush 시 version 검사는 그래도 일어난다). */
  expectedVersion?: number;
}

/** 단말기 상태를 바꾸는 유일한 경로. 규칙 확인, 상태 변경, 이력 기록을 한 트랜잭션으로 묶는다. */
@Injectable()
export class TransitionService {
  constructor(private readonly em: EntityManager) {}

  /**
   * @param em 이미 열린 트랜잭션에 합류할 때 넘긴다(예: 검수 저장과 같은 트랜잭션).
   */
  async transition(cmd: TransitionCommand, em: EntityManager = this.em): Promise<Terminal> {
    return em.transactional(async (tx) => {
      const terminal = await tx.findOne(Terminal, { serialNo: cmd.serialNo }, { populate: ['model'] });
      if (!terminal) throw new NotFoundException(`단말기 ${cmd.serialNo}이(가) 없습니다.`);

      // 규칙보다 version을 먼저 본다. 낡은 화면에서 온 요청은 "규칙 위반"이 아니라 "충돌"로 알려야 한다.
      if (cmd.expectedVersion !== undefined) {
        await tx.lock(terminal, LockMode.OPTIMISTIC, cmd.expectedVersion);
      }

      const check = checkTransition(terminal.status, cmd.to, cmd.source, {
        requiresReinspection: terminal.model.requiresReinspection,
      });
      if (!check.ok) throw new InvalidTransitionError(check.reason);

      const from = terminal.status;
      terminal.status = cmd.to;
      tx.create(TerminalStatusHistory, {
        terminal,
        fromStatus: from,
        toStatus: cmd.to,
        source: cmd.source,
        actor: cmd.actor,
        reason: cmd.reason,
      });
      return terminal;
    });
  }
}
```

`apps/api/src/terminal/terminal.controller.ts` 전체를 다음으로 바꾼다:
```ts
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { RegisterTerminalDto } from './dto/register-terminal.dto.js';
import { ListTerminalsQuery } from './dto/list-terminals.query.js';
import { TransitionDto } from './dto/transition.dto.js';
import { TerminalService } from './terminal.service.js';
import { TransitionService } from './transition.service.js';
import { TransitionSource } from './terminal-status.js';
import { toHistoryView, toTerminalView } from './terminal.views.js';

@Controller('terminals')
export class TerminalController {
  constructor(
    private readonly terminals: TerminalService,
    private readonly transitions: TransitionService,
  ) {}

  @Post()
  async register(@Body() dto: RegisterTerminalDto, @Operator() actor: string) {
    return toTerminalView(await this.terminals.register(dto, actor));
  }

  @Get()
  async list(@Query() query: ListTerminalsQuery) {
    const result = await this.terminals.list(query);
    return { ...result, items: result.items.map(toTerminalView) };
  }

  @Get(':serialNo')
  async get(@Param('serialNo') serialNo: string) {
    return toTerminalView(await this.terminals.getBySerial(serialNo));
  }

  @Get(':serialNo/history')
  async history(@Param('serialNo') serialNo: string) {
    return (await this.terminals.history(serialNo)).map(toHistoryView);
  }

  @Post(':serialNo/transitions')
  @HttpCode(200)
  async transition(@Param('serialNo') serialNo: string, @Body() dto: TransitionDto, @Operator() actor: string) {
    const terminal = await this.transitions.transition({
      serialNo,
      to: dto.to,
      reason: dto.reason,
      actor,
      source: TransitionSource.MANUAL,
      expectedVersion: dto.expectedVersion,
    });
    return toTerminalView(terminal);
  }
}
```

`apps/api/src/terminal/terminal.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { TerminalController } from './terminal.controller.js';
import { TerminalService } from './terminal.service.js';
import { TransitionService } from './transition.service.js';

@Module({
  controllers: [TerminalController],
  providers: [TerminalService, TransitionService],
  exports: [TerminalService, TransitionService],
})
export class TerminalModule {}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run && npm run typecheck`
Expected: 전체 통과, typecheck exit 0
- 응답의 `version`이 오르지 않으면 flush 뒤 엔티티 version이 메모리에 반영되지 않은 것이다. 실제 DB 값을 조회해 비교하고 troubleshooting에 기록한다.

- [ ] **Step 5: 기록과 커밋**

`docs/decisions/0004-동시-수정은-낙관적-락과-expectedVersion.md`:
- 상황: 운영자 수동 변경, 배치, 스캔이 같은 단말기를 동시에 바꿀 수 있다.
- 선택지:
  1. 비관적 락(`SELECT ... FOR UPDATE`): 확실하지만 잠금 대기가 생기고, 화면을 보는 동안의 변경은 막지 못한다.
  2. 낙관적 락(`version`): 충돌 시 한쪽이 실패한다. 단말기 하나를 동시에 바꾸는 일은 드물어 충분하다.
  3. Redis 분산 락: DB 하나로 끝나는 문제에 쓸 이유가 없다.
- 결정: 2. 사람이 바꾸는 API는 `expectedVersion`을 필수로 받는다. 화면에서 본 뒤 다른 변경이 끼어들었는지까지 잡기 위해서다. 시스템 작업은 생략할 수 있지만, flush할 때 `WHERE version = ?` 검사는 항상 일어난다.
- 응답 규칙: 충돌 409 `VERSION_CONFLICT`, 규칙 위반 422 `INVALID_TRANSITION`, 중복 409 `DUPLICATE`. version 검사를 규칙 검사보다 먼저 하는 이유도 적는다.
- 다시 볼 조건: 같은 단말기에 충돌이 잦아지면(실험 수치로 확인) 1을 검토한다.

devlog에 덧붙이고, backlog에 추가:
```
- [ ] em.lock(OPTIMISTIC, expectedVersion)과 flush 시 version 검사의 차이 (transition.service.ts)
- [ ] em.transactional 중첩 — 바깥 트랜잭션이 있으면 savepoint가 되는 이유 (transition.service.ts em 인자)
```
```bash
git add apps/api docs
git commit -m "feat(F2): 상태 전이 서비스·API와 낙관적 락 409" -m "Refs: docs/decisions/0004-동시-수정은-낙관적-락과-expectedVersion.md"
```

---

### Task 6: 동시 수정 실험 (F2)

**Files:**
- Test: `apps/api/test/terminal-concurrency.e2e.spec.ts`
- Record: `docs/experiments/0001-같은-단말기-동시-전이.md`

- [ ] **Step 1: 실험 테스트 작성**

`apps/api/test/terminal-concurrency.e2e.spec.ts`:
```ts
import { OptimisticLockError } from '@mikro-orm/mysql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '../src/common/domain-errors.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatusHistory } from '../src/terminal/terminal-status-history.entity.js';
import { TerminalStatus, TransitionSource } from '../src/terminal/terminal-status.js';
import { TransitionService } from '../src/terminal/transition.service.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const N = 20;
const OP = { 'X-Operator': 'park' };

describe(`동시 수정 실험: 같은 단말기에 전이 ${N}건 동시 요청`, () => {
  let t: TestApp;

  async function setStatus(serialNo: string, status: TerminalStatus) {
    const em = t.orm.em.fork();
    const terminal = await em.findOneOrFail(Terminal, { serialNo });
    terminal.status = status;
    await em.flush();
    return terminal.version;
  }

  async function countHistory(serialNo: string, to: TerminalStatus) {
    return t.orm.em.fork().count(TerminalStatusHistory, { terminal: { serialNo }, toStatus: to });
  }

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await t.http().post('/terminals').set(OP).send({ serialNo: 'CC-0001', modelCode: 'SN-100' });
    await t.http().post('/terminals').set(OP).send({ serialNo: 'CC-0002', modelCode: 'SN-100' });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('A. HTTP + 같은 expectedVersion: 1건만 200, 나머지는 409', async () => {
    const version = await setStatus('CC-0001', TerminalStatus.IN_STOCK);
    const started = performance.now();
    const responses = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        t
          .http()
          .post('/terminals/CC-0001/transitions')
          .set(OP)
          .send({ to: 'ALLOCATED', reason: `동시 배정 ${i}`, expectedVersion: version }),
      ),
    );
    const elapsed = Math.round(performance.now() - started);
    const byStatus = responses.reduce<Record<number, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
    console.log(`[실험 A] N=${N} 결과=${JSON.stringify(byStatus)} 소요=${elapsed}ms`);

    expect(byStatus[200]).toBe(1);
    expect(byStatus[409]).toBe(N - 1);
    expect(await countHistory('CC-0001', TerminalStatus.ALLOCATED)).toBe(1);
  });

  it('B. 시스템 작업(expectedVersion 없음): 1건만 성공, 나머지는 충돌 또는 규칙 위반', async () => {
    await setStatus('CC-0002', TerminalStatus.ALLOCATED);
    const service = t.app.get(TransitionService);
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        service.transition(
          {
            serialNo: 'CC-0002',
            to: TerminalStatus.IN_STOCK,
            reason: `배정 취소 ${i}`,
            actor: 'system:experiment',
            source: TransitionSource.MANUAL,
          },
          t.orm.em.fork(),
        ),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const reasons = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason instanceof OptimisticLockError ? 'OptimisticLock' : r.reason instanceof InvalidTransitionError ? 'InvalidTransition' : String(r.reason)));
    const tally = reasons.reduce<Record<string, number>>((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {});
    console.log(`[실험 B] N=${N} 성공=${ok} 실패=${JSON.stringify(tally)}`);

    expect(ok).toBe(1);
    expect(Object.keys(tally).every((k) => k === 'OptimisticLock' || k === 'InvalidTransition')).toBe(true);
    expect(await countHistory('CC-0002', TerminalStatus.IN_STOCK)).toBe(1);
  });
});
```

- [ ] **Step 2: 실행 (3회 반복해 결과 수집)**

Run: `for i in 1 2 3; do npx vitest run test/terminal-concurrency.e2e.spec.ts --reporter=verbose 2>&1 | grep -E "\[실험|passed|failed"; done`
Expected: 3회 모두 2개 테스트 통과. 회차마다 `[실험 A]`, `[실험 B]` 줄이 나온다.
- A는 회차와 관계없이 `{"200":1,"409":19}`여야 한다.
- B는 OptimisticLock과 InvalidTransition의 비율이 회차마다 달라도 정상이다. 이유를 기록에 적는다.
- 하나라도 실패하면 고치기 전에 troubleshooting에 증상과 출력을 먼저 기록한다.

- [ ] **Step 3: 실험 기록**

`docs/experiments/0001-같은-단말기-동시-전이.md` — `docs/README.md`의 experiments 양식으로 쓴다.
- 질문: 같은 단말기에 전이 20건이 동시에 오면 1건만 반영되는가?
- 설정: 로컬 Docker MySQL 8.4, 앱 1개 프로세스, N=20.
- 재현 명령: Step 2의 명령.
- 결과: 3회분 출력 원문을 표로 정리한다.
- 결론
- B에서 실패 이유가 두 가지로 갈리는 이유: 먼저 읽고 늦게 flush한 요청은 version 충돌로, 앞 요청이 커밋된 뒤에 읽은 요청은 "같은 상태로의 전이" 규칙 위반으로 실패한다.
- 한계: 단일 프로세스·로컬 DB라 네트워크 지연이 없다. 멀티 프로세스 실험은 Day 2 워커 2개 실험에서 다룬다.

devlog에 덧붙이고 커밋:
```bash
git add apps/api docs
git commit -m "exp(F2): 같은 단말기 동시 전이 실험" -m "Refs: docs/experiments/0001-같은-단말기-동시-전이.md"
```

---

### Task 7: 검수 체크리스트 — 검수 항목, 검수 결과로 전이 (F13)

**Files:**
- Create: `apps/api/src/inspection/inspection-item.entity.ts`, `apps/api/src/inspection/inspection.entities.ts`, `apps/api/src/inspection/dto/inspect.dto.ts`, `apps/api/src/inspection/inspection.service.ts`, `apps/api/src/inspection/inspection.controller.ts`, `apps/api/src/inspection/inspection.module.ts`
- Modify: `apps/api/src/entities.ts`, `apps/api/src/db/seed-reference.ts`, `apps/api/src/app.module.ts`
- Test: `apps/api/test/inspection.e2e.spec.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/inspection.e2e.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'choi' };
const SN100_PASS = [
  { itemCode: 'POWER', passed: true },
  { itemCode: 'NETWORK', passed: true },
  { itemCode: 'CARD_READER', passed: true },
  { itemCode: 'PRINTER', passed: true },
];

describe('검수 체크리스트 (F13)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    for (const serialNo of ['IN-0001', 'IN-0002', 'IN-0003', 'IN-0004']) {
      await t.http().post('/terminals').set(OP).send({ serialNo, modelCode: 'SN-100' });
    }
    await t.http().post('/terminals').set(OP).send({ serialNo: 'IN-0201', modelCode: 'SN-200' });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('모델별 검수 항목을 순서대로 준다', async () => {
    const res = await t.http().get('/inspection-items').query({ modelCode: 'SN-200' });
    expect(res.status).toBe(200);
    expect(res.body.map((i: { code: string }) => i.code)).toEqual(['POWER', 'LTE', 'CARD_READER', 'BATTERY']);
  });

  it('전 항목 합격이면 INSPECTED, 검수 경로 이력이 남는다', async () => {
    const res = await t.http().post('/terminals/IN-0001/inspections').set(OP).send({ results: SN100_PASS });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ passed: true, failedItems: [], terminal: { status: 'INSPECTED' } });

    const history = await t.http().get('/terminals/IN-0001/history');
    expect(history.body.at(-1)).toMatchObject({ toStatus: 'INSPECTED', source: 'INSPECTION', actor: 'choi', reason: '검수 합격' });
  });

  it('하나라도 불합격이면 DEFECTIVE, 사유에 불합격 항목이 들어간다', async () => {
    const results = SN100_PASS.map((r) => (r.itemCode === 'PRINTER' ? { ...r, passed: false, note: '인쇄 흐림' } : r));
    const res = await t.http().post('/terminals/IN-0002/inspections').set(OP).send({ results });
    expect(res.body).toMatchObject({ passed: false, failedItems: ['PRINTER'], terminal: { status: 'DEFECTIVE' } });
    const history = await t.http().get('/terminals/IN-0002/history');
    expect(history.body.at(-1).reason).toBe('검수 불합격: PRINTER');
  });

  it('항목이 빠지거나 모르는 항목이 있으면 400, 상태 그대로', async () => {
    const res = await t
      .http()
      .post('/terminals/IN-0003/inspections')
      .set(OP)
      .send({ results: [...SN100_PASS.slice(0, 3), { itemCode: 'LTE', passed: true }] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ missing: ['PRINTER'], unknown: ['LTE'] });
    expect((await t.http().get('/terminals/IN-0003')).body.status).toBe('RECEIVED');
  });

  it('같은 항목을 두 번 보내면 400', async () => {
    const res = await t
      .http()
      .post('/terminals/IN-0003/inspections')
      .set(OP)
      .send({ results: [...SN100_PASS, { itemCode: 'POWER', passed: false }] });
    expect(res.status).toBe(400);
  });

  it('검수할 수 없는 상태(재고)면 422이고 검수 기록도 남지 않는다', async () => {
    const em = t.orm.em.fork();
    const terminal = await em.findOneOrFail(Terminal, { serialNo: 'IN-0004' });
    terminal.status = TerminalStatus.IN_STOCK;
    await em.flush();

    const res = await t.http().post('/terminals/IN-0004/inspections').set(OP).send({ results: SN100_PASS });
    expect(res.status).toBe(422);
    const stats = await t.http().get('/inspections/stats').query({ modelCode: 'SN-100' });
    const power = stats.body.find((s: { itemCode: string }) => s.itemCode === 'POWER');
    expect(power.total).toBe(2); // IN-0001, IN-0002만. IN-0004의 시도는 롤백됐다.
  });

  it('SN-200은 회수 후 재검수로 다시 INSPECTED가 될 수 있다', async () => {
    const em = t.orm.em.fork();
    const terminal = await em.findOneOrFail(Terminal, { serialNo: 'IN-0201' });
    terminal.status = TerminalStatus.RETURNED;
    await em.flush();

    const results = ['POWER', 'LTE', 'CARD_READER', 'BATTERY'].map((itemCode) => ({ itemCode, passed: true }));
    const res = await t.http().post('/terminals/IN-0201/inspections').set(OP).send({ results });
    expect(res.body.terminal.status).toBe('INSPECTED');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/inspection.e2e.spec.ts`
Expected: FAIL, `/inspection-items` 404

- [ ] **Step 3: 엔티티와 시드**

`apps/api/src/inspection/inspection-item.entity.ts`:
```ts
import { OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';
import { TerminalModel } from '../terminal/terminal-model.entity.js';

/** 모델별 검수 체크리스트 항목 */
@Entity({ tableName: 'inspection_item' })
@Unique({ properties: ['model', 'code'] })
export class InspectionItem {
  [OptionalProps]?: 'sortOrder';

  @PrimaryKey()
  id!: number;

  @ManyToOne(() => TerminalModel)
  model!: Rel<TerminalModel>;

  @Property({ length: 30 })
  code!: string;

  @Property({ length: 50 })
  label!: string;

  @Property()
  sortOrder: number = 0;
}
```

`apps/api/src/inspection/inspection.entities.ts`:
```ts
import { Collection, OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, ManyToOne, OneToMany, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { Terminal } from '../terminal/terminal.entity.js';

// Inspection ↔ InspectionResult는 서로 참조한다. ESM에서 파일을 나누면 순환 import가 생기므로 한 파일에 두고,
// 참조되는 쪽(Inspection)을 먼저 선언한다.

/** 검수 1회. 결과 항목과 함께 저장되고, 저장과 같은 트랜잭션에서 단말기 상태가 바뀐다. */
@Entity({ tableName: 'inspection' })
export class Inspection {
  [OptionalProps]?: 'inspectedAt';

  @PrimaryKey()
  id!: number;

  @ManyToOne(() => Terminal)
  terminal!: Rel<Terminal>;

  @Property()
  passed!: boolean;

  @Property({ length: 50 })
  actor!: string;

  @Property()
  inspectedAt: Date = new Date();

  @OneToMany(() => InspectionResult, (r) => r.inspection)
  results = new Collection<InspectionResult>(this);
}

@Entity({ tableName: 'inspection_result' })
export class InspectionResult {
  @PrimaryKey()
  id!: number;

  @ManyToOne(() => Inspection)
  inspection!: Rel<Inspection>;

  @Property({ length: 30 })
  itemCode!: string;

  @Property()
  passed!: boolean;

  @Property({ length: 200, nullable: true })
  note?: string | null;
}
```

`apps/api/src/entities.ts`:
```ts
import { TerminalModel } from './terminal/terminal-model.entity.js';
import { Terminal } from './terminal/terminal.entity.js';
import { TerminalStatusHistory } from './terminal/terminal-status-history.entity.js';
import { InspectionItem } from './inspection/inspection-item.entity.js';
import { Inspection, InspectionResult } from './inspection/inspection.entities.js';

/** 앱·마이그레이션·시드가 함께 쓰는 엔티티 목록. 엔티티를 추가하면 여기에도 추가한다. */
export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult];
```

`apps/api/src/db/seed-reference.ts` 전체를 다음으로 바꾼다:
```ts
import type { EntityManager } from '@mikro-orm/mysql';
import { TerminalModel } from '../terminal/terminal-model.entity.js';
import { InspectionItem } from '../inspection/inspection-item.entity.js';

interface ModelSeed {
  code: string;
  name: string;
  requiresReinspection: boolean;
  /** 검수 항목 [코드, 이름], 순서대로 */
  items: [string, string][];
}

export const MODEL_SEEDS: ModelSeed[] = [
  {
    code: 'SN-100',
    name: '유선 카운터형',
    requiresReinspection: false,
    items: [['POWER', '전원'], ['NETWORK', '유선 통신'], ['CARD_READER', '카드리더'], ['PRINTER', '영수증 프린터']],
  },
  {
    code: 'SN-200',
    name: '무선 LTE형',
    requiresReinspection: true,
    items: [['POWER', '전원'], ['LTE', 'LTE 통신'], ['CARD_READER', '카드리더'], ['BATTERY', '배터리']],
  },
  {
    code: 'SN-300',
    name: '테이블오더 태블릿형',
    requiresReinspection: false,
    items: [['POWER', '전원'], ['NETWORK', '무선 통신'], ['TOUCHSCREEN', '터치스크린']],
  },
];

/** 기준 데이터(모델, 검수 항목)를 넣는다. 이미 있는 행은 건너뛰므로 여러 번 실행해도 된다. */
export async function seedReference(em: EntityManager): Promise<void> {
  for (const seed of MODEL_SEEDS) {
    let model = await em.findOne(TerminalModel, { code: seed.code });
    if (!model) {
      model = em.create(TerminalModel, { code: seed.code, name: seed.name, requiresReinspection: seed.requiresReinspection });
      await em.flush();
    }
    for (const [sortOrder, [code, label]] of seed.items.entries()) {
      const exists = await em.findOne(InspectionItem, { model, code });
      if (!exists) em.create(InspectionItem, { model, code, label, sortOrder });
    }
  }
  await em.flush();
}
```

- [ ] **Step 4: DTO, 서비스, 컨트롤러, 모듈**

`apps/api/src/inspection/dto/inspect.dto.ts`:
```ts
import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsBoolean, IsOptional, IsString, Length, ValidateNested } from 'class-validator';

export class InspectionResultDto {
  @IsString()
  itemCode!: string;

  @IsBoolean()
  passed!: boolean;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  note?: string;
}

export class InspectDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => InspectionResultDto)
  results!: InspectionResultDto[];
}
```

`apps/api/src/inspection/inspection.service.ts`:
```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatus, TransitionSource } from '../terminal/terminal-status.js';
import { TransitionService } from '../terminal/transition.service.js';
import type { InspectDto } from './dto/inspect.dto.js';
import { InspectionItem } from './inspection-item.entity.js';
import { Inspection, InspectionResult } from './inspection.entities.js';

@Injectable()
export class InspectionService {
  constructor(
    private readonly em: EntityManager,
    private readonly transitions: TransitionService,
  ) {}

  async itemsForModel(modelCode: string): Promise<InspectionItem[]> {
    return this.em.find(InspectionItem, { model: { code: modelCode } }, { orderBy: { sortOrder: 'asc' } });
  }

  /** 검수 기록과 상태 전이를 한 트랜잭션으로 저장한다. 전이가 거절되면 검수 기록도 남지 않는다. */
  async inspect(serialNo: string, dto: InspectDto, actor: string) {
    return this.em.transactional(async (tx) => {
      const terminal = await tx.findOne(Terminal, { serialNo }, { populate: ['model'] });
      if (!terminal) throw new NotFoundException(`단말기 ${serialNo}이(가) 없습니다.`);

      const items = await tx.find(InspectionItem, { model: terminal.model });
      const expected = new Set(items.map((i) => i.code));
      const given = dto.results.map((r) => r.itemCode);
      const missing = [...expected].filter((code) => !given.includes(code));
      const unknown = given.filter((code) => !expected.has(code));
      const duplicated = given.filter((code, i) => given.indexOf(code) !== i);
      if (missing.length || unknown.length || duplicated.length) {
        throw new BadRequestException({
          statusCode: 400,
          message: '검수 결과가 모델 체크리스트와 맞지 않습니다.',
          missing,
          unknown,
          duplicated,
        });
      }

      const failedItems = dto.results.filter((r) => !r.passed).map((r) => r.itemCode);
      const passed = failedItems.length === 0;
      const inspection = tx.create(Inspection, { terminal, passed, actor });
      for (const r of dto.results) {
        tx.create(InspectionResult, { inspection, itemCode: r.itemCode, passed: r.passed, note: r.note ?? null });
      }

      const updated = await this.transitions.transition(
        {
          serialNo,
          to: passed ? TerminalStatus.INSPECTED : TerminalStatus.DEFECTIVE,
          reason: passed ? '검수 합격' : `검수 불합격: ${failedItems.join(', ')}`,
          actor,
          source: TransitionSource.INSPECTION,
        },
        tx,
      );
      return { inspection, passed, failedItems, terminal: updated };
    });
  }
}
```

`apps/api/src/inspection/inspection.controller.ts`:
```ts
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { toTerminalView } from '../terminal/terminal.views.js';
import { InspectDto } from './dto/inspect.dto.js';
import { InspectionService } from './inspection.service.js';

@Controller()
export class InspectionController {
  constructor(private readonly inspections: InspectionService) {}

  @Get('inspection-items')
  async items(@Query('modelCode') modelCode: string) {
    const items = await this.inspections.itemsForModel(modelCode);
    return items.map((i) => ({ code: i.code, label: i.label, sortOrder: i.sortOrder }));
  }

  @Post('terminals/:serialNo/inspections')
  async inspect(@Param('serialNo') serialNo: string, @Body() dto: InspectDto, @Operator() actor: string) {
    const r = await this.inspections.inspect(serialNo, dto, actor);
    return { inspectionId: r.inspection.id, passed: r.passed, failedItems: r.failedItems, terminal: toTerminalView(r.terminal) };
  }
}
```

`apps/api/src/inspection/inspection.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { TerminalModule } from '../terminal/terminal.module.js';
import { InspectionController } from './inspection.controller.js';
import { InspectionService } from './inspection.service.js';

@Module({
  imports: [TerminalModule],
  controllers: [InspectionController],
  providers: [InspectionService],
})
export class InspectionModule {}
```

`apps/api/src/app.module.ts`의 imports를 다음으로 바꾸고 `InspectionModule` import 문을 추가한다:
```ts
import { InspectionModule } from './inspection/inspection.module.js';
// ...
  imports: [MikroOrmModule.forRoot(ormConfig), TerminalModule, InspectionModule],
```

이 Task의 마지막 테스트(`stats`)는 Task 8에서 통과한다. Step 5에서는 그 테스트만 실패한다.

- [ ] **Step 5: 통과 확인 (stats 의존 테스트 제외)**

Run: `npx vitest run test/inspection.e2e.spec.ts`
Expected: `검수할 수 없는 상태(재고)면 422...` 1건만 FAIL(`/inspections/stats` 404). 나머지 6건은 PASS.
- 422 응답 자체는 맞는지 실패 메시지에서 확인한다.

- [ ] **Step 6: 마이그레이션과 시드**

Run: `npm run db:migration:create && npm run db:migrate && npm run db:seed && npm run db:migration:check`
Expected: `inspection_item`(model_id+code unique), `inspection`, `inspection_result` 테이블 생성, 마지막 줄 `최신 상태`

- [ ] **Step 7: 기록과 커밋 (WIP 표시)**

devlog에 덧붙이고, backlog에 추가:
```
- [ ] 트랜잭션 안에서 다른 서비스 호출하기 — em을 인자로 넘기는 방식과 @Transactional 데코레이터 비교 (inspection.service.ts)
- [ ] OneToMany Collection과 cascade persist (inspection.entities.ts)
```
```bash
git add apps/api docs
git commit -m "feat(F13): 검수 체크리스트와 검수 결과 전이"
```

---

### Task 8: 검수 불합격 통계 (F13)

**Files:**
- Modify: `apps/api/src/inspection/inspection.service.ts`, `apps/api/src/inspection/inspection.controller.ts`
- Test: `apps/api/test/inspection.e2e.spec.ts`(Task 7 테스트가 통과해야 함) + 아래 테스트 추가

- [ ] **Step 1: 통계 테스트 추가**

`apps/api/test/inspection.e2e.spec.ts`의 `describe` 안 맨 끝에 추가:
```ts
  it('불합격 통계: 항목별 검수 수·불합격 수·불합격률, 불합격 많은 순', async () => {
    const res = await t.http().get('/inspections/stats').query({ modelCode: 'SN-100' });
    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual({ modelCode: 'SN-100', itemCode: 'PRINTER', total: 2, failed: 1, failRate: 0.5 });
    expect(res.body.find((s: { itemCode: string }) => s.itemCode === 'POWER')).toEqual({
      modelCode: 'SN-100',
      itemCode: 'POWER',
      total: 2,
      failed: 0,
      failRate: 0,
    });
  });

  it('모델을 안 주면 전체 모델 통계', async () => {
    const res = await t.http().get('/inspections/stats');
    expect(new Set(res.body.map((s: { modelCode: string }) => s.modelCode))).toEqual(new Set(['SN-100', 'SN-200']));
  });
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/inspection.e2e.spec.ts`
Expected: 통계 관련 3건 FAIL (404)

- [ ] **Step 3: 구현**

`apps/api/src/inspection/inspection.service.ts`의 클래스 안 마지막에 메서드를 추가한다:
```ts
  /** 모델·항목별 불합격 통계. 집계는 DB에서 한 번에 한다(행을 앱으로 가져와 세지 않는다). */
  async failureStats(modelCode?: string) {
    const params: string[] = [];
    let where = '';
    if (modelCode) {
      where = 'where m.code = ?';
      params.push(modelCode);
    }
    const rows: { model_code: string; item_code: string; total: number | string; failed: number | string }[] =
      await this.em.execute(
        `select m.code as model_code, r.item_code, count(*) as total,
                sum(case when r.passed then 0 else 1 end) as failed
           from inspection_result r
           join inspection i on i.id = r.inspection_id
           join terminal t on t.id = i.terminal_id
           join terminal_model m on m.id = t.model_id
           ${where}
          group by m.code, r.item_code
          order by failed desc, m.code, r.item_code`,
        params,
      );
    return rows.map((row) => {
      // COUNT는 숫자, SUM은 DECIMAL이라 mysql2가 문자열로 줄 수 있다.
      const total = Number(row.total);
      const failed = Number(row.failed);
      return {
        modelCode: row.model_code,
        itemCode: row.item_code,
        total,
        failed,
        failRate: total ? Math.round((failed / total) * 1000) / 1000 : 0,
      };
    });
  }
```

`apps/api/src/inspection/inspection.controller.ts`의 클래스 안에 추가:
```ts
  @Get('inspections/stats')
  async stats(@Query('modelCode') modelCode?: string) {
    return this.inspections.failureStats(modelCode);
  }
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run && npm run typecheck`
Expected: 전체 통과, typecheck exit 0.
- `em.execute`의 반환 타입이 맞지 않는다는 오류가 나면 제네릭 대신 결과를 `as` 로 단언하고, 그 이유를 troubleshooting에 짧게 남긴다.

- [ ] **Step 5: 실행계획 확인 (MSSQL 경험 이식)**

Run (terminal-ops 루트, 개발 DB):
```bash
MSYS_NO_PATHCONV=1 docker exec terminal-ops-mysql sh -c 'mysql -uterminal_ops -p"$MYSQL_PASSWORD" terminal_ops -e "explain select m.code, r.item_code, count(*) from inspection_result r join inspection i on i.id = r.inspection_id join terminal t on t.id = i.terminal_id join terminal_model m on m.id = t.model_id where m.code = \"SN-100\" group by m.code, r.item_code"'
```
Expected: 각 join이 PK/FK 인덱스를 쓰는지(`type`이 `eq_ref`/`ref`) 확인한다. 개발 DB에 데이터가 거의 없어 `ALL`이 나올 수 있다. 그 사실과 "데이터를 늘린 실험은 Day 5 대조 쿼리에서 한다"는 메모를 devlog에 적는다.

- [ ] **Step 6: 기록과 커밋**

devlog에 덧붙이고 커밋:
```bash
git add apps/api docs
git commit -m "feat(F13): 검수 항목별 불합격 통계"
```

---

### Task 9: 1일차 마감 — 전체 검증과 기록 정리

**Files:**
- Record: `docs/decisions/0005-엑셀-일괄-등록은-Day3로.md`, `docs/devlog/<오늘>.md`, `docs/study/backlog.md`
- Modify: `../01_B_단말기생애주기_설계안.md`(저장소 밖, 커밋 대상 아님)

- [ ] **Step 1: 전체 검증**

Run:
```bash
npx vitest run
npm run typecheck
npm run build
npm run db:migration:check
```
Expected: 모든 테스트 통과(개수를 기록), typecheck/build exit 0, `최신 상태`

- [ ] **Step 2: 실제 서버 수동 확인**

Run: `node dist/main.js`(백그라운드) 후:
```bash
curl -s -X POST localhost:3000/terminals -H 'Content-Type: application/json' -H 'X-Operator: manual' -d '{"serialNo":"DEV-0001","modelCode":"SN-300"}'
curl -s localhost:3000/inspection-items?modelCode=SN-300
curl -s -X POST localhost:3000/terminals/DEV-0001/inspections -H 'Content-Type: application/json' -H 'X-Operator: manual' -d '{"results":[{"itemCode":"POWER","passed":true},{"itemCode":"NETWORK","passed":true},{"itemCode":"TOUCHSCREEN","passed":true}]}'
curl -s localhost:3000/terminals/DEV-0001/history
```
Expected:
- 등록 응답 `status: RECEIVED`
- 검수 항목 3개
- 검수 응답 `terminal.status: INSPECTED`
- 이력 2건

출력을 devlog에 붙인다. 확인이 끝나면 서버를 종료한다.

- [ ] **Step 3: 결정 기록 0005**

`docs/decisions/0005-엑셀-일괄-등록은-Day3로.md`:
- 상황: 설계안 F1에 엑셀 일괄 등록이 있다.
- 선택지:
  1. Day 1에 함께 만든다.
  2. Day 3의 F6 박스 일괄 스캔과 함께 만든다.
- 결정: 2.
- 이유: 둘 다 "여러 건을 한 번에 처리하고 행별 성공·실패를 돌려주는" 같은 문제다. 대량 flush 방식과 결과 형식을 한 번에 설계하는 편이 낫다. 엑셀 라이브러리 설치(이 PC에서 약 5분)도 그때 한다.

- [ ] **Step 4: 하루 요약과 공부거리 정리**

devlog 맨 아래에 `## 1일차 요약`을 쓴다.
- 만든 API 목록
- 테스트 수
- 커밋 목록(`git log --oneline`)
- 실험 0001 결론 한 줄
- 계획과 달라진 점
- 내일(Day 2) 시작 전에 필요한 것

`docs/study/backlog.md`의 중복 항목은 합친다.

설계안 `../01_B_단말기생애주기_설계안.md` 8장 Day 1 행 끝에 `✅ 완료(커밋 범위)`를 표시한다. 이 파일은 저장소 밖이라 커밋하지 않는다.

- [ ] **Step 5: 커밋**

```bash
git add docs
git commit -m "docs: 1일차 마감 기록" -m "Refs: docs/decisions/0005-엑셀-일괄-등록은-Day3로.md"
```

---

## Self-Review 결과

- 설계안 F1:
  - 등록·조회 → Task 3
  - 엑셀 일괄 → Day 3로 이동(Task 9 decisions/0005)
- 설계안 F2:
  - 전이·이력 → Task 4·5
  - 사유 필수 → TransitionDto `reason`
  - 동시 수정 테스트 → Task 6
- 설계안 F13:
  - 검수 항목·결과 → Task 7
  - 불합격 통계 → Task 8
- 설계안 2장 "동시 수정 → 낙관적 락": Task 5·6. "잘못된 최종 상태 0건"은 이력 수 = 1로 검증한다.
- 기록 규칙: 모든 Task에 devlog 단계가 있다. 결정 0002~0005, 트러블슈팅 0002, 실험 0001.
- 타입·이름 일관성:
  - `TransitionService.transition(cmd, em?)`, `TransitionCommand`, `checkTransition(from, to, source, policy)`
  - `toTerminalView` / `toHistoryView`, `seedReference`, `createTestApp` / `resetDatabase`
  - Task 3~8에서 같은 이름을 쓴다.
