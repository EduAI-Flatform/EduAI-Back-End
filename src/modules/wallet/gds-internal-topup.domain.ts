import { GdsWalletInvariantError } from './gds-wallet.domain';
import { GdsPayosTopupIntent } from './gds-payos-topup.domain';

/**
 * PAYW-04 proposed CLOSED-LOOP / service-prepayment model, sandbox-only.
 * NOT an e-wallet issuer, merchant configuration, legal approval or live credit path.
 * Nothing here writes to a wallet, Commerce settlement or database.
 *
 * Only the server-side PayOS signature-verification + provider-reconciliation
 * adapter may construct an authoritative settlement. Browser callbacks and
 * uploaded bank receipts must never call this mapping.
 */
export interface GdsInternalPayosSettlement {
  orderCode: bigint;
  paymentLinkId: string;
  amountMinor: bigint;
  amountRemainingMinor: bigint;
  currency: 'VND';
  receivingAccountHash: string;
  settlementReceivingAccountHash?: string;
  collectionReference: string;
  status: 'PAID';
  signatureVerifiedAt: Date;
  providerReconciledAt: Date;
}

export interface GdsInternalTopupCredit {
  /** Globally unique and stable across retries; not an event ID from the buyer. */
  eventId: string;
  buyerId: string;
  collectionReference: string;
  amountMinor: bigint;
  currency: 'VND';
  source: 'PAYOS_MERCHANT_COLLECTION';
}

function invariant(code: string): never {
  throw new GdsWalletInvariantError(code);
}

/**
 * Converts a fully verified, reconciled business-bank collection to a CANDIDATE
 * internal service-credit event at exactly 1 GDS per received VND.
 *
 * Future persistence requires regulatory/product approval plus one SERIALIZABLE
 * transaction locking buyer wallet + PayOS order + global collection reference;
 * only that transaction can make the credit spendable. Fees are separate.
 */
export function prepareGdsInternalTopupCredit(
  intent: GdsPayosTopupIntent,
  settlement: GdsInternalPayosSettlement,
): GdsInternalTopupCredit {
  if (intent.status !== 'PAYOS_VERIFIED' || !intent.collectionReference || !intent.buyerId ||
      typeof intent.amountMinor !== 'bigint' || intent.amountMinor <= 0n ||
      typeof intent.payosOrderCode !== 'bigint') {
    invariant('GDS_INTERNAL_TOPUP_NOT_ELIGIBLE');
  }
  if (settlement.status !== 'PAID' || settlement.amountRemainingMinor !== 0n ||
      settlement.currency !== 'VND' || settlement.amountMinor !== intent.amountMinor ||
      settlement.orderCode !== intent.payosOrderCode ||
      !intent.paymentLinkId || settlement.paymentLinkId !== intent.paymentLinkId ||
      settlement.receivingAccountHash !== intent.receivingAccountHash ||
      settlement.collectionReference !== intent.collectionReference ||
      (intent.settlementReceivingAccountHash != null &&
        settlement.settlementReceivingAccountHash !== intent.settlementReceivingAccountHash)) {
    invariant('GDS_INTERNAL_TOPUP_PAYMENT_MISMATCH');
  }
  if (!(settlement.signatureVerifiedAt instanceof Date) ||
      !Number.isFinite(settlement.signatureVerifiedAt.getTime()) ||
      !(settlement.providerReconciledAt instanceof Date) ||
      !Number.isFinite(settlement.providerReconciledAt.getTime()) ||
      settlement.providerReconciledAt < settlement.signatureVerifiedAt) {
    invariant('GDS_INTERNAL_TOPUP_NOT_RECONCILED');
  }
  return {
    eventId: `payos-gds-topup:${intent.payosOrderCode.toString()}`,
    buyerId: intent.buyerId,
    collectionReference: settlement.collectionReference,
    amountMinor: intent.amountMinor,
    currency: 'VND',
    source: 'PAYOS_MERCHANT_COLLECTION',
  };
}

/**
 * Checks topup-only credits independently of course purchases/debits.
 * The future full double-entry journal must separately reconcile all debits,
 * refunds, merchant liability and seller allocation before a balance is shown.
 */
export function projectGdsInternalTopupCredits(
  entries: readonly GdsInternalTopupCredit[],
): bigint {
  const events = new Map<string, string>();
  const references = new Map<string, string>();
  let creditedMinor = 0n;
  for (const entry of entries) {
    if (!entry.eventId || !entry.buyerId || !entry.collectionReference ||
        typeof entry.amountMinor !== 'bigint' || entry.amountMinor <= 0n ||
        entry.currency !== 'VND' || entry.source !== 'PAYOS_MERCHANT_COLLECTION') {
      invariant('GDS_INTERNAL_TOPUP_INVALID_CREDIT');
    }
    const fingerprint = `${entry.buyerId}:${entry.collectionReference}:${entry.amountMinor}:${entry.currency}:${entry.source}`;
    const prior = events.get(entry.eventId);
    if (prior) {
      if (prior !== fingerprint) invariant('GDS_INTERNAL_TOPUP_EVENT_COLLISION');
      continue;
    }
    const existingEvent = references.get(entry.collectionReference);
    if (existingEvent) invariant('GDS_INTERNAL_TOPUP_COLLECTION_REPLAY');
    events.set(entry.eventId, fingerprint);
    references.set(entry.collectionReference, entry.eventId);
    creditedMinor += entry.amountMinor;
  }
  return creditedMinor;
}
