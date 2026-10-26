import { Module } from '@nestjs/common';
import { env } from '../config/env.js';
import { OutboxService } from './outbox.service.js';
import { ToktokClient } from './toktok.client.js';

@Module({
  providers: [
    OutboxService,
    {
      provide: ToktokClient,
      useFactory: () => new ToktokClient({ baseUrl: env.partnersUrl, channel: env.toktokChannel, timeoutMs: env.partnerTimeoutMs }),
    },
  ],
  exports: [OutboxService, ToktokClient],
})
export class OutboxModule {}
