import { Module } from '@nestjs/common';
import { PayOS } from '@payos/node';
import { AppConfigModule } from '../../config/app-config.module';
import { AppConfigService } from '../../config/app-config.service';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { DisabledPaymentProvider } from './disabled-payment.provider';
import { PAYMENT_PROVIDER, PaymentProvider } from './payment-provider';
import { PayosClientPort, PayosPaymentProvider } from './payos-payment.provider';
import { PaymentRequestController } from './payment-request.controller';
import { PaymentRequestService } from './payment-request.service';

const PAYOS_CLIENT = Symbol('PAYOS_CLIENT');

@Module({
  imports: [AppConfigModule, AuditModule, AuthModule, PrismaModule],
  controllers: [PaymentRequestController],
  providers: [
    PaymentRequestService,
    DisabledPaymentProvider,
    {
      provide: PAYOS_CLIENT,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): PayosClientPort | null => {
        const payos = config.payos;
        if (payos.environment === 'disabled') return null;

        return new PayOS({
          apiKey: payos.apiKey,
          baseURL: payos.apiBaseUrl,
          checksumKey: payos.checksumKey,
          clientId: payos.clientId,
          logLevel: 'off',
          logger: null,
          maxRetries: 0,
          timeout: payos.timeoutMs,
        }) as unknown as PayosClientPort;
      },
    },
    {
      provide: PayosPaymentProvider,
      inject: [PAYOS_CLIENT],
      useFactory: (client: PayosClientPort | null) => new PayosPaymentProvider(client),
    },
    {
      provide: PAYMENT_PROVIDER,
      inject: [AppConfigService, DisabledPaymentProvider, PayosPaymentProvider],
      useFactory: (
        config: AppConfigService,
        disabled: DisabledPaymentProvider,
        payos: PayosPaymentProvider,
      ): PaymentProvider =>
        config.payos.environment === 'production' ? payos : disabled,
    },
  ],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentsModule {}
