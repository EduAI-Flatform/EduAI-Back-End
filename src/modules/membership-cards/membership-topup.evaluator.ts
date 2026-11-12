import { createHash } from 'node:crypto';
import type { Prisma } from '../../../generated/prisma/client';

export const membershipTopupSelect = {
  id: true, buyerId: true, walletId: true, amountMinor: true, currency: true, status: true,
  payosOrderCode: true, paymentLinkId: true, collectionReference: true,
  receivingAccountHash: true, settlementReceivingAccountHash: true,
  creditedAt: true, signatureVerifiedAt: true, providerReconciledAt: true,
  wallet: { select: { id: true, buyerId: true } },
  journal: { select: { id: true, walletId: true, topupId: true, kind: true, amountMinor: true,
    availableDeltaMinor: true, heldDeltaMinor: true, clearingDeltaMinor: true, collectionReference: true, occurredAt: true } },
  reconciliation: { select: { id: true, topupId: true, payosOrderCode: true, paymentLinkId: true,
    providerEventIdentity: true, amountMinor: true, currency: true, qrReceivingAccountHash: true,
    settlementReceivingAccountHash: true, signatureVerifiedAt: true, providerReconciledAt: true, occurredAt: true } },
} satisfies Prisma.GdsInternalTopupSelect;
export type MembershipTopup = Prisma.GdsInternalTopupGetPayload<{ select: typeof membershipTopupSelect }>;
const validDate = (value: Date | null): value is Date => value instanceof Date && Number.isFinite(value.getTime());

/** Read-only qualification from immutable verified credit proofs, never wallet balances or screenshots. */
export function evaluateVerifiedTopups(topups: MembershipTopup[], currency: string, at: Date, startsAt: Date) {
  const unavailable = (reason: string) => ({ status: 'unavailable' as const, reason });
  const seen = new Set<string>(), evidenceIds = new Set<string>(), evidence: string[] = [];
  let total = 0n, eligibleTopupCount = 0, excludedCurrencyCount = 0;
  for (const topup of topups) {
    if (seen.has(topup.id)) continue;
    seen.add(topup.id);
    if (topup.status !== 'CREDITED') continue;
    if (topup.currency !== currency) { excludedCurrencyCount++; continue; }
    const journal = topup.journal, proof = topup.reconciliation;
    if (!validDate(topup.creditedAt) || !validDate(topup.signatureVerifiedAt) || !validDate(topup.providerReconciledAt)
      || topup.providerReconciledAt < topup.signatureVerifiedAt || topup.creditedAt < topup.providerReconciledAt
      || topup.amountMinor <= 0n || !topup.collectionReference || !topup.paymentLinkId || !topup.receivingAccountHash
      || !topup.settlementReceivingAccountHash || topup.wallet?.id !== topup.walletId || topup.wallet.buyerId !== topup.buyerId
      || !journal || journal.topupId !== topup.id || journal.walletId !== topup.walletId || journal.kind !== 'TOPUP_CREDIT'
      || journal.amountMinor !== topup.amountMinor || journal.availableDeltaMinor !== topup.amountMinor
      || journal.heldDeltaMinor !== 0n || journal.clearingDeltaMinor !== -topup.amountMinor
      || journal.collectionReference !== topup.collectionReference || !validDate(journal.occurredAt)
      || !proof || proof.topupId !== topup.id || proof.amountMinor !== topup.amountMinor || proof.currency !== currency
      || proof.payosOrderCode !== topup.payosOrderCode || proof.paymentLinkId !== topup.paymentLinkId
      || proof.providerEventIdentity !== topup.collectionReference || proof.qrReceivingAccountHash !== topup.receivingAccountHash
      || proof.settlementReceivingAccountHash !== topup.settlementReceivingAccountHash
      || !validDate(proof.signatureVerifiedAt) || !validDate(proof.providerReconciledAt) || !validDate(proof.occurredAt)
      || proof.signatureVerifiedAt.getTime() !== topup.signatureVerifiedAt.getTime()
      || proof.providerReconciledAt.getTime() !== topup.providerReconciledAt.getTime() || proof.occurredAt > topup.providerReconciledAt
    ) return unavailable('CANONICAL_TOPUP_MISMATCH');
    if (topup.creditedAt < startsAt || topup.creditedAt > at) continue;
    if (journal.occurredAt > at) return unavailable('CANONICAL_TOPUP_MISMATCH');
    const keys = [`journal:${journal.id}`, `proof:${proof.id}`, `collection:${topup.collectionReference}`];
    if (keys.some(key => evidenceIds.has(key))) return unavailable('TOPUP_EVIDENCE_REUSED');
    keys.forEach(key => evidenceIds.add(key));
    total += topup.amountMinor;
    eligibleTopupCount++;
    evidence.push(`${topup.id}:${journal.id}:${proof.id}:${topup.collectionReference}:${topup.amountMinor}:${topup.creditedAt.toISOString()}`);
  }
  return { status: 'evaluated' as const, reason: null, qualifyingAmountMinor: total.toString(), eligibleTopupCount,
    eligibleOrderCount: 0, excludedCurrencyCount, sourceDigest: createHash('sha256').update(evidence.sort().join('\n')).digest('hex') };
}
