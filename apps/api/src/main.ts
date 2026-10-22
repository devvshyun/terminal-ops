import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { env } from './config/env.js';

const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(env.port);
console.log(`terminal-ops api listening on http://localhost:${env.port}`);
