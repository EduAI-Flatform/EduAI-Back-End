import { createHash } from 'node:crypto';
import { evaluateVerifiedTopups, type MembershipTopup } from './membership-topup.evaluator';

export interface MembershipCardTier {
  code: string; name: { vi: string; en: string }; threshold: number;
  benefits: Array<{ vi: string; en: string }>;
}
export interface MembershipCardPolicy {
  enabled: boolean; basis: 'spend' | 'topup'; currency: string; cycleMode: 'rolling';
  cycleMonths: number; tiers: MembershipCardTier[];
}
export interface MembershipSpendOrder {
  id: string; status: string; fulfillmentStatus: string; currency: string; payableAmountMinor: bigint;
  confirmedSettlementId: string | null;
  confirmedSettlement: null | { id: string; orderId: string; amountMinor: bigint; currency: string;
    settledAt: Date; kind: string; disposition: string };
  refunds: Array<{ id: string; settlementId: string; currency: string; status: string; amountMinor: bigint; recordedAt: Date | null }>;
}

/** UTC calendar-month subtraction, clamped at month end; inclusive lower bound. */
export function rollingWindowStart(at: Date, months: number): Date {
  const start = new Date(at);
  const day = start.getUTCDate();
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  start.setUTCDate(Math.min(day, lastDay));
  return start;
}

export function evaluateMembershipCard(policy: MembershipCardPolicy, policyRevisionId: string | null,
  orders: MembershipSpendOrder[], at = new Date(), topups?: MembershipTopup[]) {
  const validWindow = Number.isInteger(policy.cycleMonths) && policy.cycleMonths >= 1 && policy.cycleMonths <= 120 && Number.isFinite(at.getTime());
  const startsAt = validWindow ? rollingWindowStart(at, policy.cycleMonths) : null;
  const base = {
    policyRevisionId, basis: policy.basis, currency: policy.currency,
    evaluatedAt: Number.isFinite(at.getTime()) ? at.toISOString() : null,
    windowStartsAt: startsAt?.toISOString() ?? null, windowEndsAt: Number.isFinite(at.getTime()) ? at.toISOString() : null,
    preservesPurchasedAccess: true, qualifyingAmountMinor: null as string | null,
    tier: null as MembershipCardTier | null, eligibleOrderCount: 0, eligibleTopupCount: 0, excludedCurrencyCount: 0, sourceDigest: null as string | null,
  };
  const unavailable = (reason: string) => ({ ...base, status: 'unavailable' as const, reason });
  if (!policy.enabled) return { ...base, status: 'disabled' as const, reason: 'POLICY_DISABLED' };
  if (!policyRevisionId) return unavailable('POLICY_NOT_VERSIONED');
  if (!validWindow || policy.cycleMode !== 'rolling' || policy.currency !== 'VND' || !['spend', 'topup'].includes(policy.basis)
    || !Array.isArray(policy.tiers) || !policy.tiers.length || policy.tiers[0].threshold !== 0
    || policy.tiers.some((tier, index) => !Number.isSafeInteger(tier.threshold) || tier.threshold < 0
      || (index > 0 && tier.threshold <= policy.tiers[index - 1].threshold))
    || new Set(policy.tiers.map(tier => tier.code)).size !== policy.tiers.length) return unavailable('INVALID_POLICY');
  if (policy.basis === 'topup' && !topups) return unavailable('TOPUP_SOURCE_NOT_LOADED');

  const spend = policy.basis === 'topup'
    ? evaluateVerifiedTopups(topups!, policy.currency, at, startsAt!)
    : evaluateSettledSpend(orders, policy.currency, at, startsAt);
  if (spend.status === 'unavailable') return unavailable(spend.reason);
  const total = BigInt(spend.qualifyingAmountMinor);
  const tier = [...policy.tiers].reverse().find(item => total >= BigInt(item.threshold)) ?? null;
  return { ...base, ...spend, tier };
}

/** Verifies settlement and refund facts independently of membership qualification windows. */
export function evaluateSettledSpend(orders: MembershipSpendOrder[], currency: string, at: Date, startsAt: Date | null = null) {
  const unavailable = (reason: string) => ({ status: 'unavailable' as const, reason });
  const seenOrders = new Set<string>();
  const settlements = new Set<string>();
  const refundIds = new Set<string>();
  const evidence: string[] = [];
  let total = 0n;
  let eligibleOrderCount = 0;
  let excludedCurrencyCount = 0;
  for (const order of orders) {
    if (seenOrders.has(order.id)) continue;
    seenOrders.add(order.id);
    if (order.status !== 'confirmed' || order.fulfillmentStatus !== 'fulfilled') continue;
    if (order.currency !== currency) { excludedCurrencyCount += 1; continue; }
    const settlement = order.confirmedSettlement;
    if (!settlement || settlement.id !== order.confirmedSettlementId || settlement.orderId !== order.id
      || settlement.currency !== currency || settlement.amountMinor !== order.payableAmountMinor
      || settlement.amountMinor < 0n) return unavailable('CANONICAL_SETTLEMENT_MISMATCH');
    const verifiedKind = (settlement.kind === 'provider_collection' && settlement.disposition === 'matched')
      || (settlement.kind === 'wallet_capture' && settlement.disposition === 'internal')
      || (settlement.kind === 'no_payment_required' && settlement.amountMinor === 0n);
    if (!verifiedKind) return unavailable('UNVERIFIED_SETTLEMENT_DISPOSITION');
    if (!Number.isFinite(settlement.settledAt.getTime())) return unavailable('INVALID_SETTLEMENT_DATE');
    if ((startsAt !== null && settlement.settledAt < startsAt) || settlement.settledAt > at || settlement.amountMinor === 0n) continue;
    if (settlements.has(settlement.id)) return unavailable('SETTLEMENT_REUSED');
    settlements.add(settlement.id);
    let refunded = 0n;
    for (const refund of order.refunds) {
      if (refund.status !== 'recorded' || refund.settlementId !== settlement.id) continue;
      if (!refund.recordedAt || !Number.isFinite(refund.recordedAt.getTime())) return unavailable('INVALID_REFUND_DATE');
      if (refund.recordedAt > at) continue;
      if (refund.currency !== currency || refund.amountMinor <= 0n) return unavailable('REFUND_SOURCE_MISMATCH');
      if (refundIds.has(refund.id)) continue;
      refundIds.add(refund.id);
      refunded += refund.amountMinor;
      evidence.push(`refund:${refund.id}:${refund.amountMinor}:${refund.recordedAt.toISOString()}`);
    }
    if (refunded > settlement.amountMinor) return unavailable('REFUND_EXCEEDS_SETTLED_SPEND');
    total += settlement.amountMinor - refunded;
    eligibleOrderCount += 1;
    evidence.push(`settlement:${settlement.id}:${settlement.amountMinor}:${settlement.settledAt.toISOString()}`);
  }
  return { status: 'evaluated' as const, reason: null, qualifyingAmountMinor: total.toString(), eligibleOrderCount, excludedCurrencyCount,
    sourceDigest: createHash('sha256').update(evidence.sort().join('\n')).digest('hex') };
}
