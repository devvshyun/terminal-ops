import { Module } from '@nestjs/common';
import { env } from '../config/env.js';
import { BungaeAdapter, CarrierAdapters, NeurimboAdapter } from './carrier.adapters.js';

@Module({
  providers: [
    {
      // 어댑터는 생성자에 설정값(문자열·숫자)을 받으므로 DI 대신 팩토리로 만든다.
      provide: CarrierAdapters,
      useFactory: () => {
        const opts = { baseUrl: env.partnersUrl, timeoutMs: env.partnerTimeoutMs };
        return new CarrierAdapters([new BungaeAdapter(opts), new NeurimboAdapter(opts)]);
      },
    },
  ],
  exports: [CarrierAdapters],
})
export class CarrierModule {}
