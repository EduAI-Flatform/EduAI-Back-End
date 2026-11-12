import { Prisma } from '../../../generated/prisma/client';
import { evaluateActivityPointAward, type ActivityPointPolicy } from './activity-point-policy';

const SAMPLE_LIMIT = 5000;
/** Hypothetical replay of recent canonical activity, never a retroactive award. */
export async function computeActivityPointImpact(
  tx: Prisma.TransactionClient, before: ActivityPointPolicy, after: ActivityPointPolicy, at = new Date(),
) {
  const windowStart = new Date(at.getTime() - 30 * 86400000);
  const facts = { simulationOnly: true, historicalAwardsPreserved: true, reprocessesHistoricalEvents: false,
    windowStart: windowStart.toISOString(), windowEnd: at.toISOString(), sampleLimit: SAMPLE_LIMIT } as const;
  const events = await tx.enrollment.findMany({
    where: { status: 'completed', completedAt: { gte: windowStart, lte: at }, user: { deletedAt: null } },
    orderBy: [{ completedAt: 'asc' }, { id: 'asc' }], take: SAMPLE_LIMIT + 1,
    select: { id: true, userId: true, completedAt: true },
  });
  if (events.length > SAMPLE_LIMIT) return { ...facts, status: 'limit_exceeded' as const,
    sampledEvents: null, sampledLearners: null, affectedLearners: null, changedEvents: null, beforePoints: null, afterPoints: null };
  const oldDaily = new Map<string, number>(), newDaily = new Map<string, number>();
  const learners = new Set<string>(), affected = new Set<string>();
  let beforePoints = 0, afterPoints = 0, changedEvents = 0;
  for (const event of events) {
    if (!event.completedAt) throw new Error('POINT_ACTIVITY_SOURCE_INVALID');
    const dayKey = `${event.userId}:${event.completedAt.toISOString().slice(0, 10)}`;
    const oldAward = evaluateActivityPointAward(before, 'course.completed', event.completedAt, event.completedAt, oldDaily.get(dayKey) ?? 0);
    const newAward = evaluateActivityPointAward(after, 'course.completed', event.completedAt, event.completedAt, newDaily.get(dayKey) ?? 0);
    oldDaily.set(dayKey, (oldDaily.get(dayKey) ?? 0) + oldAward.amount);
    newDaily.set(dayKey, (newDaily.get(dayKey) ?? 0) + newAward.amount);
    beforePoints += oldAward.amount;
    afterPoints += newAward.amount;
    learners.add(event.userId);
    if (oldAward.amount !== newAward.amount || (newAward.amount > 0 && oldAward.expiresAt.getTime() !== newAward.expiresAt.getTime())) {
      changedEvents++; affected.add(event.userId);
    }
  }
  return { ...facts, status: 'evaluated' as const, sampledEvents: events.length, sampledLearners: learners.size,
    affectedLearners: affected.size, changedEvents, beforePoints, afterPoints };
}
