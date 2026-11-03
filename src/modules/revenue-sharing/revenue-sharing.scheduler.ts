import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { RevenueFinanceService } from './revenue-finance.service';
import { RevenueMembershipService } from './revenue-membership.service';
@Injectable()
export class RevenueSharingScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RevenueSharingScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(private readonly finance: RevenueFinanceService, private readonly memberships: RevenueMembershipService) {}
  onApplicationBootstrap() {
    void this.runOnce();
    this.timer = setInterval(() => { void this.runOnce(); }, 60000);
    this.timer.unref?.();
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async runOnce() {
    if (this.running) return;
    this.running = true;
    try {
      try { await this.memberships.reconcileDue(); } catch { this.logger.warn('Membership revenue changes require retry.'); }
      try { await this.finance.runBatch(); } catch { this.logger.warn('Revenue recognition requires retry.'); }
    } finally { this.running = false; }
  }
}