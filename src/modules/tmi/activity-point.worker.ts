import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivityPointService } from './activity-point.service';
import { PointLedgerService } from './point-ledger.service';

const BATCH_SIZE = 50;

@Injectable()
export class ActivityPointWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ActivityPointWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private expiryCursor?: string;
  private completionCursor?: { id: string; completedAt: Date };
  constructor(private readonly prisma: PrismaService, private readonly awards: ActivityPointService,
    private readonly ledger: PointLedgerService) {}

  onApplicationBootstrap() {
    void this.runBatch();
    this.timer = setInterval(() => void this.runBatch(), 60000);
    this.timer.unref?.();
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  async runBatch() {
    if (this.running) return;
    this.running = true;
    try {
      // Existing credits still expire when future accrual is disabled or unavailable.
      try { await this.expireBatch(); }
      catch { this.logger.warn('Point expiry scan requires retry; ledger history preserved.'); }
      try { await this.completionBatch(); }
      catch { this.logger.warn('Point activity scan requires retry; no completion state was changed.'); }
    } finally { this.running = false; }
  }

  private async expireBatch() {
    const users = await this.prisma.user.findMany({
      where: { deletedAt: null, ...(this.expiryCursor ? { id: { gt: this.expiryCursor } } : {}),
        tmiLedgerEntries: { some: { sourceType: { in: ['platform_activity', 'platform_activity_refund'] },
          kind: { in: ['earn', 'refund'] }, expiresAt: { lte: new Date() }, pointExpirySettlement: null } } },
      orderBy: { id: 'asc' }, take: BATCH_SIZE, select: { id: true },
    });
    for (const user of users) {
      try { await this.expireUser(user.id); }
      catch { this.logger.warn('Point expiry requires retry; user transaction was rolled back.'); }
    }
    this.expiryCursor = users.length === BATCH_SIZE ? users[users.length - 1].id : undefined;
  }

  private async expireUser(userId: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.prisma.$transaction(async tx => {
          const owners = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE id=${userId} AND deleted_at IS NULL FOR UPDATE`;
          if (owners.length > 0) await this.ledger.settle(tx, userId, userId, new Date(), 25);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        return;
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2034' || attempt === 2) throw error;
      }
    }
  }

  private async completionBatch() {
    const firstPolicy = await this.prisma.platformPolicyRevision.findFirst({
      where: { group: 'points', status: 'scheduled', effectiveAt: { lte: new Date() } },
      orderBy: [{ effectiveAt: 'asc' }, { version: 'asc' }], select: { effectiveAt: true },
    });
    if (!firstPolicy?.effectiveAt) return;
    const cursor = this.completionCursor;
    const completions = await this.prisma.enrollment.findMany({
      where: { status: 'completed', completedAt: { gte: firstPolicy.effectiveAt, lte: new Date() }, user: { deletedAt: null },
        pointActivityReceipts: { none: { eventType: 'course.completed' } },
        ...(cursor ? { OR: [{ completedAt: { gt: cursor.completedAt } }, { completedAt: cursor.completedAt, id: { gt: cursor.id } }] } : {}) },
      orderBy: [{ completedAt: 'asc' }, { id: 'asc' }], take: BATCH_SIZE, select: { id: true, completedAt: true },
    });
    for (const source of completions) {
      try { await this.awards.recordCourseCompletion(source.id); }
      catch { this.logger.warn('Point activity requires retry; source and policy history preserved.'); }
    }
    const last = completions[completions.length - 1];
    this.completionCursor = completions.length === BATCH_SIZE && last.completedAt ? { id: last.id, completedAt: last.completedAt } : undefined;
  }
}
