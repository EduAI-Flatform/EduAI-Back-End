import { evaluateMembershipCard, rollingWindowStart, type MembershipCardPolicy, type MembershipSpendOrder } from './membership-card.evaluator';

const at = new Date('2026-11-11T10:00:00Z');
const policy: MembershipCardPolicy = { enabled: true, basis: 'spend', currency: 'VND', cycleMode: 'rolling', cycleMonths: 12,
  tiers: [0, 100, 200].map((threshold, index) => ({ code: ['member', 'gold', 'platinum'][index], name: { vi: `Hạng ${index}`, en: `Tier ${index}` }, threshold, benefits: [] })) };
function order(id: string, amount: bigint, settledAt = at): MembershipSpendOrder {
  return { id, status: 'confirmed', fulfillmentStatus: 'fulfilled', currency: 'VND', payableAmountMinor: amount,
    confirmedSettlementId: `s-${id}`, confirmedSettlement: { id: `s-${id}`, orderId: id, amountMinor: amount, currency: 'VND', settledAt, kind: 'provider_collection', disposition: 'matched' }, refunds: [] };
}
describe('membership card evaluation', () => {
  it('classifies an administrator-added tier without limiting cards to the three initial names', () => {
    const custom = { ...policy, tiers: [...policy.tiers,
      { code: 'diamond', name: { vi: 'Kim cuong', en: 'Diamond' }, threshold: 300, benefits: [{ vi: 'D', en: 'D' }] }] };
    expect(evaluateMembershipCard(custom, 'custom-revision', [order('a', 300n)], at))
      .toMatchObject({ policyRevisionId: 'custom-revision', tier: { code: 'diamond', threshold: 300 } });
    expect(evaluateMembershipCard(custom, 'custom-revision', [order('a', 299n)], at))
      .toMatchObject({ tier: { code: 'platinum' } });
  });
  it('uses configured thresholds including the exact boundary and counts each order once', () => {
    const source = order('a', 100n);
    expect(evaluateMembershipCard(policy, 'revision-2', [source, source], at)).toMatchObject({ status: 'evaluated', policyRevisionId: 'revision-2', qualifyingAmountMinor: '100', tier: { code: 'gold' }, eligibleOrderCount: 1 });
    expect(evaluateMembershipCard(policy, 'revision-2', [order('a', 99n)], at)).toMatchObject({ tier: { code: 'member' } });
  });
  it('subtracts only recorded refunds of the canonical settlement and ignores future refunds', () => {
    const source = order('a', 200n);
    source.refunds = [
      { id: 'r-1', settlementId: 's-a', currency: 'VND', status: 'recorded', amountMinor: 50n, recordedAt: at },
      { id: 'r-2', settlementId: 's-a', currency: 'VND', status: 'requested', amountMinor: 60n, recordedAt: null },
      { id: 'r-3', settlementId: 's-a', currency: 'VND', status: 'recorded', amountMinor: 50n, recordedAt: new Date(at.getTime() + 1000) },
    ];
    expect(evaluateMembershipCard(policy, 'v', [source], at)).toMatchObject({ qualifyingAmountMinor: '150', tier: { code: 'gold' } });
  });
  it('uses a clamped UTC rolling calendar window and excludes pre-window/future settlement', () => {
    expect(rollingWindowStart(new Date('2024-03-31T12:00:00Z'), 1).toISOString()).toBe('2024-02-29T12:00:00.000Z');
    const start = rollingWindowStart(at, 12);
    const sources = [order('a', 100n, start), order('old', 900n, new Date(start.getTime() - 1)), order('future', 900n, new Date(at.getTime() + 1))];
    expect(evaluateMembershipCard(policy, 'v', sources, at)).toMatchObject({ qualifyingAmountMinor: '100', eligibleOrderCount: 1 });
  });
  it('does not count pending, free, mismatched-currency or unfulfilled purchases', () => {
    expect(evaluateMembershipCard(policy, 'v', [{ ...order('pending', 500n), status: 'pending_payment' },
      { ...order('unfulfilled', 500n), fulfillmentStatus: 'not_started' }, { ...order('usd', 500n), currency: 'USD' }, order('free', 0n)], at)).toMatchObject({ qualifyingAmountMinor: '0', tier: { code: 'member' } });
  });
  it('fails closed for inconsistent money facts and unapproved topup sources', () => {
    const source = order('a', 100n);
    source.refunds = [{ id: 'r', settlementId: 's-a', currency: 'VND', status: 'recorded', amountMinor: 101n, recordedAt: at }];
    expect(evaluateMembershipCard(policy, 'v', [source], at)).toMatchObject({ status: 'unavailable', reason: 'REFUND_EXCEEDS_SETTLED_SPEND' });
    expect(evaluateMembershipCard({ ...policy, basis: 'topup' }, 'v', [], at)).toMatchObject({ status: 'unavailable', reason: 'TOPUP_SOURCE_NOT_LOADED' });
    expect(evaluateMembershipCard({ ...policy, enabled: false }, null, [], at)).toMatchObject({ status: 'disabled', tier: null });
  });
});
