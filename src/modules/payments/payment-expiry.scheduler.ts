import {
  Injectable,
  Inject,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { PaymentLifecycleService } from './payment-lifecycle.service';
import { PAYMENT_PROVIDER_REGISTRY } from './payment-provider';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { BankTransferService } from './bank-transfer.service';

const EXPIRY_INTERVAL_MS = 60_000;
const EXPIRY_BATCH_LIMIT = 20;

@Injectable()
export class PaymentExpiryScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentExpiryScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private readonly lifecycle: PaymentLifecycleService,
    private readonly config: AppConfigService,
    @Optional()
    @Inject(PAYMENT_PROVIDER_REGISTRY)
    private readonly providerRegistry?: PaymentProviderRegistry,
    @Optional() private readonly bank?: BankTransferService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.hasActiveProvider()) return;

    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, EXPIRY_INTERVAL_MS);
    this.timer.unref?.();
  }

  private hasActiveProvider(): boolean {
    if (this.bank?.enabled()) return true;
    if (this.providerRegistry) {
      return this.providerRegistry.isEnabled('payos') || this.providerRegistry.isEnabled('vnpay');
    }
    return this.config.payos.environment === 'production';
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async runOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const bankResult = await this.bank?.expireDue();
      if (bankResult?.failed) this.logger.warn(`Sandbox bank checkpoint: expired=${bankResult.expired} fulfilled=${bankResult.fulfilled} failed=${bankResult.failed}`);
      const result = await this.lifecycle.runExpiry(null, { limit: EXPIRY_BATCH_LIMIT });
      if (result.checkedCount > 0 || result.reviewRequiredCount > 0) {
        this.logger.log(
          `Payment expiry checkpoint: checked=${result.checkedCount} expired=${result.expiredCount} settled=${result.settledCount} review=${result.reviewRequiredCount} hasMore=${result.hasMore}`,
        );
      }
    } catch {
      this.logger.warn('Payment expiry checkpoint failed; it will retry on the next interval.');
    } finally {
      this.inFlight = false;
    }
  }
}
