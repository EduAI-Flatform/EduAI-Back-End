import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { AuditAction } from '../../common/audit/audit.constants';
import { PrismaService } from '../../prisma/prisma.service';
import { evaluateActivityPointAward, type ActivityPointPolicy } from './activity-point-policy';

const sourceSelect = { id: true, userId: true, status: true, completedAt: true } as const;

/** Internal adapter only: no user-supplied amount, recipient, date or policy. */
@Injectable()
export class ActivityPointService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async recordCourseCompletion(sourceId: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(async tx => {
          const discovered = await tx.enrollment.findUnique({ where: { id: sourceId }, select: sourceSelect });
          if (!discovered) return null;
          const owners = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE id=${discovered.userId} AND deleted_at IS NULL FOR UPDATE`;
          if (owners.length === 0) return null;
          const existing = await tx.pointActivityReceipt.findUnique({
            where: { eventType_sourceId: { eventType: 'course.completed', sourceId } },
          });
          if (existing) return existing;
          const source = await tx.enrollment.findUnique({ where: { id: sourceId }, select: sourceSelect });
          if (!source || source.userId !== discovered.userId) throw new Error('POINT_ACTIVITY_SOURCE_CHANGED');
          if (source.status !== 'completed' || !source.completedAt) return null;
          const processedAt = new Date();
          if (source.completedAt > processedAt) throw new Error('POINT_ACTIVITY_DATE_INVALID');
          const policy = await tx.platformPolicyRevision.findFirst({
            where: { group: 'points', status: 'scheduled', effectiveAt: { lte: source.completedAt } },
            orderBy: [{ effectiveAt: 'desc' }, { version: 'desc' }],
            select: { id: true, content: true },
          });
          if (!policy) return null;
          const dayStart = new Date(source.completedAt);
          dayStart.setUTCHours(0, 0, 0, 0);
          const nextDay = new Date(dayStart.getTime() + 86400000);
          const daily = await tx.pointActivityReceipt.aggregate({
            where: { userId: source.userId, occurredAt: { gte: dayStart, lt: nextDay } },
            _sum: { amount: true },
          });
          const award = evaluateActivityPointAward(policy.content as unknown as ActivityPointPolicy,
            'course.completed', source.completedAt, processedAt, daily._sum.amount ?? 0);
          const posting = award.amount > 0 ? await tx.tmiLedgerEntry.create({
            data: { userId: source.userId, kind: 'earn', amount: award.amount,
              sourceType: 'platform_activity', sourceId, actorId: source.userId,
              occurredAt: processedAt, expiresAt: award.expiresAt,
              metadata: { event: 'course.completed', policyRevisionId: policy.id, occurredAt: source.completedAt.toISOString() } },
            select: { id: true },
          }) : null;
          const receipt = await tx.pointActivityReceipt.create({
            data: { userId: source.userId, eventType: 'course.completed', sourceId, policyRevisionId: policy.id,
              outcome: award.outcome, amount: award.amount, occurredAt: source.completedAt,
              expiresAt: award.expiresAt, ledgerEntryId: posting?.id ?? null, createdAt: processedAt },
          });
          await this.audit.record({ actorId: source.userId, action: AuditAction.PointActivityRecorded,
            target: { type: 'point_activity_receipt', id: receipt.id },
            metadata: { sourceId, policyRevisionId: policy.id, outcome: award.outcome, amount: award.amount } }, tx);
          return receipt;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2034' || attempt === 2) throw error;
      }
    }
    throw new Error('POINT_ACTIVITY_CONCURRENCY_CONFLICT');
  }
}
