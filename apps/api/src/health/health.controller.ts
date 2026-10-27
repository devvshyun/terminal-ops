import { Controller, Get } from '@nestjs/common';
import type { HealthView } from '@terminal-ops/contracts';

@Controller('health')
export class HealthController {
  @Get()
  check(): HealthView {
    return { status: 'ok' };
  }
}
