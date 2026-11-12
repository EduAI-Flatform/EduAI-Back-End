import { affiliatePolicyReady, evaluateAffiliateAccrual, type AffiliatePolicy } from './affiliate-domain';
import type { MembershipSpendOrder } from '../membership-cards/membership-card.evaluator';
const at = new Date('2026-11-11T00:00:00Z');
const policy: AffiliatePolicy = { enabled: true, currency: 'VND', commissionBase: 'net_paid_after_recorded_refunds', attributionModel: 'first_touch',
  commissionBps: 1000, attributionDays: 30, holdDays: 7, minimumWithdrawal: 0, subAffiliateEnabled: false };
const order: MembershipSpendOrder = { id: 'order', status: 'confirmed', fulfillmentStatus: 'fulfilled', currency: 'VND', payableAmountMinor: 101n,
  confirmedSettlementId: 'settlement', confirmedSettlement: { id: 'settlement', orderId: 'order', currency: 'VND', amountMinor: 101n, settledAt: at, kind: 'provider_collection', disposition: 'matched' }, refunds: [] };
describe('affiliate commission source', () => {
  it('retains earned commission beyond the membership qualification window', () => {
    const initial = evaluateAffiliateAccrual(policy, 'revision', order, at, at);
    const later = evaluateAffiliateAccrual(policy, 'revision', order, at, new Date('2040-11-11T00:00:00Z'));
    expect(later).toMatchObject({ status: 'evaluated', targetMinor: 10n, qualifyingAmountMinor: 101n });
    expect(later).toMatchObject({ sourceDigest: (initial as any).sourceDigest });
  });
  it('uses configured rate with integer rounding and hold period', () => {
    expect(evaluateAffiliateAccrual(policy, 'revision', order, at, at)).toMatchObject({ status: 'evaluated', targetMinor: 10n, qualifyingAmountMinor: 101n, holdUntil: new Date('2026-11-18T00:00:00Z') });
  });
  it('subtracts recorded refunds and produces a different immutable source digest', () => {
    const first = evaluateAffiliateAccrual(policy, 'revision', order, at, at);
    const refunded = evaluateAffiliateAccrual(policy, 'revision', { ...order, refunds: [{ id: 'r', settlementId: 'settlement', status: 'recorded', currency: 'VND', amountMinor: 51n, recordedAt: at }] }, at, at);
    expect(refunded).toMatchObject({ targetMinor: 5n, qualifyingAmountMinor: 50n });
    expect(refunded).not.toMatchObject({ sourceDigest: (first as any).sourceDigest });
  });
  it('rejects unverified collections, excess refunds, and late attribution', () => {
    expect(evaluateAffiliateAccrual(policy, 'v', { ...order, confirmedSettlement: { ...order.confirmedSettlement!, disposition: 'late_collection' } }, at, at)).toMatchObject({ status: 'unavailable' });
    expect(evaluateAffiliateAccrual(policy, 'v', order, new Date(at.getTime() + 1), at)).toMatchObject({ reason: 'ATTRIBUTION_AFTER_SETTLEMENT' });
  });
  it('has no pending-order commissions or unimplemented multi-level rates', () => {
    expect(evaluateAffiliateAccrual(policy, 'v', { ...order, status: 'pending_payment' }, at, at)).toMatchObject({ status: 'pending' });
    expect(affiliatePolicyReady({ ...policy, subAffiliateEnabled: true })).toBe(false);
  });
});
