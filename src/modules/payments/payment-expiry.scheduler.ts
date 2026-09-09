import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { PaymentLifecycleService } from './payment-lifecycle.service';

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
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.payos.environment !== 'production') return;

    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, EXPIRY_INTERVAL_MS);
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async runOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
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
