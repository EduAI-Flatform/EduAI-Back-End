import { Module } from '@nestjs/common';
import { PayOS } from '@payos/node';
import { AppConfigModule } from '../../config/app-config.module';
import { AppConfigService } from '../../config/app-config.service';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CommerceFulfillmentService } from './commerce-fulfillment.service';
import { DisabledPaymentProvider } from './disabled-payment.provider';
import {
  PAYMENT_PROVIDER,
  PAYMENT_PROVIDER_REGISTRY,
  PaymentProvider,
} from './payment-provider';
import {
  DefaultPaymentProviderRegistry,
  PaymentProviderRegistry,
} from './payment-provider.registry';
import { PayosClientPort, PayosPaymentProvider } from './payos-payment.provider';
import { VnPayPaymentProvider } from './vnpay-payment.provider';
import { PaymentExpiryScheduler } from './payment-expiry.scheduler';
import { PaymentRequestController } from './payment-request.controller';
import { PaymentRequestService } from './payment-request.service';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PaymentWebhookService } from './payment-webhook.service';
import { PaymentReconciliationController } from './payment-reconciliation.controller';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PaymentLifecycleService } from './payment-lifecycle.service';
import { PaymentLifecycleController } from './payment-lifecycle.controller';
import { PaymentRefundController } from './payment-refund.controller';
import { PaymentRefundService } from './payment-refund.service';

const PAYOS_CLIENT = Symbol('PAYOS_CLIENT');

@Module({
  imports: [AppConfigModule, AuditModule, AuthModule, PrismaModule, NotificationsModule],
  controllers: [PaymentRequestController, PaymentWebhookController, PaymentReconciliationController, PaymentLifecycleController, PaymentRefundController],
  providers: [
    PaymentRequestService,
    PaymentWebhookService,
    CommerceFulfillmentService,
    PaymentReconciliationService,
    PaymentLifecycleService,
    PaymentExpiryScheduler,
    PaymentRefundService,
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
      provide: VnPayPaymentProvider,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        new VnPayPaymentProvider(config.vnpay),
    },
    {
      provide: PAYMENT_PROVIDER_REGISTRY,
      inject: [
        AppConfigService,
        DisabledPaymentProvider,
        PayosPaymentProvider,
        VnPayPaymentProvider,
      ],
      useFactory: (
        config: AppConfigService,
        disabled: DisabledPaymentProvider,
        payos: PayosPaymentProvider,
        vnpay: VnPayPaymentProvider,
      ): PaymentProviderRegistry =>
        new DefaultPaymentProviderRegistry({
          defaultProvider: config.payment.defaultProvider,
          providers: { payos, vnpay },
          enabled: {
            payos: config.payos.environment === 'production',
            vnpay: config.vnpay.environment !== 'disabled',
          },
          disabled,
        }),
    },
    {
      provide: PAYMENT_PROVIDER,
      inject: [PAYMENT_PROVIDER_REGISTRY],
      useFactory: (registry: PaymentProviderRegistry): PaymentProvider =>
        // Webhook/lifecycle/reconciliation remain PayOS-specific until the
        // later settlement-neutral tasks; new attempts use the registry.
        registry.get('payos'),
    },
  ],
  exports: [PAYMENT_PROVIDER, PAYMENT_PROVIDER_REGISTRY],
})
export class PaymentsModule {}
