import { createHash } from 'node:crypto';
import { evaluateSettledSpend, type MembershipSpendOrder } from '../membership-cards/membership-card.evaluator';
export interface AffiliatePolicy {
  fundingSource?: string;
  allocationPrecedence?: string;
  enabled: boolean;
  currency: string;
  commissionBase: string;
  attributionModel: string;
  commissionBps: number;
  attributionDays: number;
  holdDays: number;
  minimumWithdrawal: number;
  subAffiliateEnabled: boolean;
}
export function affiliatePolicyReady(policy: AffiliatePolicy) {
  return policy.currency === 'VND' && policy.commissionBase === 'net_paid_after_recorded_refunds'
    && policy.attributionModel === 'first_touch' && Number.isInteger(policy.commissionBps)
    && policy.commissionBps >= 0 && policy.commissionBps <= 10000
    && Number.isInteger(policy.holdDays) && policy.holdDays >= 0 && policy.holdDays <= 365
    && Number.isInteger(policy.attributionDays) && policy.attributionDays >= 1 && policy.attributionDays <= 365
    && !policy.subAffiliateEnabled;
}
/** Uses the same settlement/refund proof as card qualification, without a rolling purchase cutoff. */
export function evaluateAffiliateAccrual(policy: AffiliatePolicy, revisionId: string, order: MembershipSpendOrder,
  attributedAt: Date, at = new Date()) {
  if (!affiliatePolicyReady(policy)) return { status: 'unavailable' as const, reason: 'INVALID_AFFILIATE_POLICY' };
  if (order.status !== 'confirmed' || order.fulfillmentStatus !== 'fulfilled') return { status: 'pending' as const, reason: 'ORDER_NOT_SETTLED' };
  if (order.currency !== policy.currency) return { status: 'unavailable' as const, reason: 'UNSUPPORTED_ORDER_CURRENCY' };
  const evaluated = evaluateSettledSpend([order], policy.currency, at);
  if (evaluated.status !== 'evaluated' || evaluated.qualifyingAmountMinor === null) {
    return { status: 'unavailable' as const, reason: evaluated.reason };
  }
  const settlement = order.confirmedSettlement;
  if (!settlement || settlement.settledAt < attributedAt) return { status: 'unavailable' as const, reason: 'ATTRIBUTION_AFTER_SETTLEMENT' };
  if (settlement.settledAt > at) return { status: 'pending' as const, reason: 'FUTURE_SETTLEMENT' };
  const qualifyingAmountMinor = BigInt(evaluated.qualifyingAmountMinor);
  const targetMinor = qualifyingAmountMinor * BigInt(policy.commissionBps) / 10000n;
  const holdUntil = new Date(settlement.settledAt.getTime() + policy.holdDays * 86400000);
  return {
    status: 'evaluated' as const, reason: null, qualifyingAmountMinor, targetMinor, holdUntil,
    sourceDigest: createHash('sha256').update(JSON.stringify({
      revisionId, source: evaluated.sourceDigest, basis: qualifyingAmountMinor.toString(), bps: policy.commissionBps,
    })).digest('hex'),
  };
}
