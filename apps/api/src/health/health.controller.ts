import { Controller, Get } from '@nestjs/common';
import type { HealthView } from '@terminal-ops/contracts';
import { Public } from '../auth/access.js';

@Controller('health')
export class HealthController {
  @Get()
  @Public()
  check(): HealthView {
    return { status: 'ok' };
  }
}
