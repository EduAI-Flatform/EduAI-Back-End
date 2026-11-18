import { Prisma } from '../../../generated/prisma/client';
import { evaluateSettledSpend } from '../membership-cards/membership-card.evaluator';
import { affiliateOrderSelect } from './affiliate-source';

// Resource safeguards, not configurable commercial thresholds. Probe one extra
// record and refuse a partial total, including high-fan-out refund sources.
const ORDER_LIMIT = 1000;
const REFUND_LIMIT = 10000;
type Source = Pick<Prisma.TransactionClient, 'affiliateAccrual' | 'affiliateAttribution' | 'commerceRefund'>;

export async function loadAffiliateSummary(db: Source, ownerId: string, asOf: Date) {
  if (!Number.isFinite(asOf.getTime())) throw new Error('INVALID_AFFILIATE_SUMMARY_DATE');
  const day = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const month = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));
  const sum = async (start?: Date) => {
    const result = await db.affiliateAccrual.aggregate({
      where: { attribution: { identity: { ownerId } }, createdAt: { lt: asOf, ...(start ? { gte: start } : {}) } },
      _sum: { deltaMinor: true },
    });
    return (result._sum.deltaMinor ?? 0n).toString();
  };
  const lifetime = await sum();
  const today = await sum(day);
  const monthly = await sum(month);
  const revenue = await revenueAt(db, ownerId, asOf);
  return {
    asOf: asOf.toISOString(), timeZone: 'UTC' as const, currency: 'VND' as const,
    commissionBasis: 'recorded_signed_accruals' as const,
    lifetimeCommissionMinor: lifetime, commissionStatus: 'available' as const, commissionReason: null,
    today: { startsAt: day.toISOString(), endsBefore: asOf.toISOString(), amountMinor: today },
    month: { startsAt: month.toISOString(), endsBefore: asOf.toISOString(), amountMinor: monthly },
    revenue,
    ranking: { status: 'unconfigured' as const, value: null, reason: 'RANKING_POLICY_NOT_CONFIGURED' },
    subAffiliates: { status: 'disabled' as const, count: null, reason: 'SUB_AFFILIATE_POLICY_NOT_ENABLED' },
  };
}

async function revenueAt(db: Source, ownerId: string, asOf: Date) {
  const basis = 'net_verified_paid_after_recorded_refunds' as const;
  const unavailable = (reason: string, complete = true) => ({
    basis, status: 'unavailable' as const, amountMinor: null, complete, reason,
  });
  const rows = await db.affiliateAttribution.findMany({
    where: { identity: { ownerId }, createdAt: { lt: asOf } }, orderBy: { id: 'asc' }, take: ORDER_LIMIT + 1,
    select: { id: true, identityId: true, policyRevisionId: true, createdAt: true,
      visit: { select: { identityId: true, policyRevisionId: true, createdAt: true } },
      order: { select: { ...affiliateOrderSelect, refunds: false } } },
  });
  if (rows.length > ORDER_LIMIT) return unavailable('SOURCE_SCAN_LIMIT_EXCEEDED', false);
  const eligible = rows.filter(row => row.order.status === 'confirmed' && row.order.fulfillmentStatus === 'fulfilled'
    && !(row.order.confirmedSettlement && row.order.confirmedSettlement.settledAt >= asOf));
  for (const row of eligible) {
    if (row.order.currency !== 'VND') return unavailable('UNSUPPORTED_ORDER_CURRENCY');
    if (row.createdAt >= asOf || row.visit.createdAt > row.createdAt
      || row.visit.identityId !== row.identityId || row.visit.policyRevisionId !== row.policyRevisionId
      || (row.order.confirmedSettlement && row.order.confirmedSettlement.settledAt < row.createdAt)) {
      return unavailable('INVALID_ATTRIBUTION_CHRONOLOGY');
    }
  }
  const ids = [...new Set(eligible.map(row => row.order.id))];
  const refunds = ids.length ? await db.commerceRefund.findMany({
    where: { orderId: { in: ids }, status: 'recorded', OR: [{ recordedAt: { lt: asOf } }, { recordedAt: null }] },
    orderBy: { id: 'asc' }, take: REFUND_LIMIT + 1,
    select: { id: true, orderId: true, settlementId: true, currency: true, status: true, amountMinor: true, recordedAt: true },
  }) : [];
  if (refunds.length > REFUND_LIMIT) return unavailable('REFUND_SCAN_LIMIT_EXCEEDED', false);
  const byOrder = new Map<string, typeof refunds>();
  for (const refund of refunds) {
    const list = byOrder.get(refund.orderId) ?? [];
    list.push(refund); byOrder.set(refund.orderId, list);
  }
  const result = evaluateSettledSpend(eligible.map(row => ({ ...row.order, refunds: byOrder.get(row.order.id) ?? [] })), 'VND', asOf);
  if (result.status !== 'evaluated') return unavailable(result.reason);
  return { basis, status: 'available' as const, amountMinor: result.qualifyingAmountMinor, complete: true, reason: null };
}
