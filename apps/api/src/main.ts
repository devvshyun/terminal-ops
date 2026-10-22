import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { env } from './config/env.js';

const app = await NestFactory.create(AppModule.forRoot({ workers: env.runWorkers, schedulers: env.runSchedulers }));
app.enableShutdownHooks();
await app.listen(env.port);
console.log(
  `terminal-ops api listening on http://localhost:${env.port} (workers=${env.runWorkers}, schedulers=${env.runSchedulers}, queuePrefix=${env.queuePrefix})`,
);
