import { evaluateMembershipCard, type MembershipCardPolicy } from './membership-card.evaluator';
import type { MembershipTopup } from './membership-topup.evaluator';

const at = new Date('2026-11-12T10:00:00Z');
const policy: MembershipCardPolicy = { enabled: true, basis: 'topup', currency: 'VND', cycleMode: 'rolling', cycleMonths: 12,
  tiers: [0, 100, 200].map((threshold, index) => ({ code: ['member', 'gold', 'platinum'][index], name: { vi: 'Tier', en: 'Tier' }, threshold, benefits: [] })) };
export function creditedTopup(id = 'a', amount = 100n, creditedAt = at): MembershipTopup {
  return { id, buyerId: 'owner', walletId: 'wallet', amountMinor: amount, currency: 'VND', status: 'CREDITED',
    payosOrderCode: 123n, paymentLinkId: `link-${id}`, collectionReference: `event-${id}`,
    receivingAccountHash: 'qr-hash', settlementReceivingAccountHash: 'bank-hash',
    creditedAt, signatureVerifiedAt: creditedAt, providerReconciledAt: creditedAt,
    wallet: { id: 'wallet', buyerId: 'owner' },
    journal: { id: `journal-${id}`, walletId: 'wallet', topupId: id, kind: 'TOPUP_CREDIT', amountMinor: amount,
      availableDeltaMinor: amount, heldDeltaMinor: 0n, clearingDeltaMinor: -amount, collectionReference: `event-${id}`, occurredAt: creditedAt },
    reconciliation: { id: `proof-${id}`, topupId: id, payosOrderCode: 123n, paymentLinkId: `link-${id}`,
      providerEventIdentity: `event-${id}`, amountMinor: amount, currency: 'VND', qrReceivingAccountHash: 'qr-hash',
      settlementReceivingAccountHash: 'bank-hash', signatureVerifiedAt: creditedAt, providerReconciledAt: creditedAt, occurredAt: creditedAt },
  };
}
describe('verified top-up card qualification', () => {
  it('counts each proven credited top-up once at the exact threshold without counting spend', () => {
    const source = creditedTopup();
    expect(evaluateMembershipCard(policy, 'revision', [], at, [source, source])).toMatchObject({
      status: 'evaluated', tier: { code: 'gold' }, qualifyingAmountMinor: '100', eligibleTopupCount: 1,
      eligibleOrderCount: 0, policyRevisionId: 'revision', preservesPurchasedAccess: true,
    });
  });
  it('does not qualify pending, cancelled, pre-window, future or foreign-currency top-ups', () => {
    const pending = { ...creditedTopup('pending'), status: 'PENDING_PAYOS' };
    const old = creditedTopup('old', 100n, new Date('2025-11-12T09:59:59Z'));
    const future = creditedTopup('future', 100n, new Date(at.getTime() + 1));
    expect(evaluateMembershipCard(policy, 'v', [], at, [pending, old, future, { ...creditedTopup('usd'), currency: 'USD' }]))
      .toMatchObject({ status: 'evaluated', qualifyingAmountMinor: '0', excludedCurrencyCount: 1 });
  });
  it.each(['journal', 'reconciliation', 'wallet'] as const)('fails closed with missing %s evidence', field => {
    expect(evaluateMembershipCard(policy, 'v', [], at, [{ ...creditedTopup(), [field]: null }]))
      .toMatchObject({ status: 'unavailable', reason: 'CANONICAL_TOPUP_MISMATCH', tier: null });
  });
  it('rejects proof mismatch, unbalanced journal, invalid dates and evidence reused by a different top-up', () => {
    const source = creditedTopup();
    for (const invalid of [
      { ...source, collectionReference: 'other' },
      { ...source, wallet: { id: 'wallet', buyerId: 'another-owner' } },
      { ...source, journal: { ...source.journal!, clearingDeltaMinor: 0n } },
      { ...source, reconciliation: { ...source.reconciliation!, amountMinor: 99n } },
      { ...source, signatureVerifiedAt: new Date(NaN) },
    ]) expect(evaluateMembershipCard(policy, 'v', [], at, [invalid])).toMatchObject({ status: 'unavailable' });
    const reused = creditedTopup('b');
    reused.journal!.id = source.journal!.id;
    expect(evaluateMembershipCard(policy, 'v', [], at, [source, reused])).toMatchObject({ status: 'unavailable', reason: 'TOPUP_EVIDENCE_REUSED' });
  });
  it('does not fabricate zero qualification when the source was not loaded', () => {
    expect(evaluateMembershipCard(policy, 'v', [], at)).toMatchObject({ status: 'unavailable', reason: 'TOPUP_SOURCE_NOT_LOADED' });
    expect(evaluateMembershipCard(policy, 'v', [], at, [])).toMatchObject({ status: 'evaluated', qualifyingAmountMinor: '0' });
  });
});
