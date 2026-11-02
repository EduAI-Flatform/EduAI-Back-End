import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { GdsPayosInboxService } from './gds-payos-inbox.service';

/** Retry after process restarts and provider outages; never active on production. */
@Injectable()
export class GdsPayosInboxScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(GdsPayosInboxScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly inbox: GdsPayosInboxService) {}

  onApplicationBootstrap(): void {
    if (!this.inbox.enabled()) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.inbox.processPending();
      if (result.processed || result.reviewed) {
        this.logger.log(`GDS PayOS inbox: processed=${result.processed} review=${result.reviewed} retry=${result.deferred}`);
      }
    } catch {
      this.logger.warn('GDS PayOS inbox temporarily unavailable; next checkpoint will retry.');
    } finally { this.running = false; }
  }
}
