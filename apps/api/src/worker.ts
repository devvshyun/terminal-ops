import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { env } from './config/env.js';

// HTTP 없이 큐 job만 처리하는 프로세스. 여러 개 띄워 같은 큐를 나눠 처리할 수 있다(experiments/0005).
const app = await NestFactory.createApplicationContext(AppModule.forRoot({ workers: true, schedulers: env.runSchedulers }));
app.enableShutdownHooks();
console.log(`terminal-ops worker ready (name=${env.workerName}, schedulers=${env.runSchedulers}, queuePrefix=${env.queuePrefix})`);
