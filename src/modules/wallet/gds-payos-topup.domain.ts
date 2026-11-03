import { GdsWalletInvariantError, GdsWalletVerifiedEvent } from './gds-wallet.domain';

/** No beneficiary is known until the authenticated PayOS create response. */
export const GDS_UNBOUND_RECEIVING_ACCOUNT_HASH = '0'.repeat(64);

/** PayOS is a collection gateway, not the issuer of customer wallet value. */
export type GdsPayosTopupStatus =
  | 'CREATED'
  | 'PENDING_PAYOS'
  | 'PAYOS_VERIFIED'
  | 'PENDING_PARTNER'
  | 'CREDITED'
  | 'CANCELLED'
  | 'REVIEW';

export interface GdsPayosTopupIntent {
  id: string;
  buyerId: string;
  amountMinor: bigint;
  currency: 'VND';
  payosOrderCode: bigint;
  /** SHA256 of accountNumber in authenticated link creation; it may be a QR virtual account. */
  receivingAccountHash: string;
  /** Physical receiver, scoped to this link after signed webhook and GET agree. */
  settlementReceivingAccountHash?: string | null;
  createdAt?: Date;
  expiresAt: Date;
  status: GdsPayosTopupStatus;
  paymentLinkId: string | null;
  collectionReference: string | null;
  partnerCreditEventId: string | null;
}

export interface GdsPayosCreatedLink {
  orderCode: bigint;
  amountMinor: bigint;
  currency: 'VND';
  paymentLinkId: string;
  checkoutUrl: string;
  receivingAccountHash: string;
}

export interface GdsPayosVerifiedCollection {
  /** Trusted server-only fact from SDK webhook verification / provider query. */
  orderCode: bigint;
  amountMinor: bigint;
  currency: 'VND';
  paymentLinkId: string;
  collectionReference: string;
  receivingAccountHash: string;
  occurredAt: Date;
  providerCode: '00';
}

export interface GdsPartnerVerifiedCredit {
  /** Separately authenticated evidence from a permitted wallet partner. */
  eventId: string;
  /** Immutable transaction ID allocated by the licensed wallet partner. */
  partnerTransactionId: string;
  amountMinor: bigint;
  currency: 'VND';
  sourceCollectionReference: string;
}

function requireTopup(value: GdsPayosTopupIntent): void {
  if (!value.id || !value.buyerId || typeof value.amountMinor !== 'bigint' ||
      typeof value.payosOrderCode !== 'bigint' || value.amountMinor <= 0n ||
      value.amountMinor > BigInt(Number.MAX_SAFE_INTEGER) || value.currency !== 'VND' ||
      value.payosOrderCode <= 0n || value.payosOrderCode > BigInt(Number.MAX_SAFE_INTEGER) ||
      !/^[a-f0-9]{64}$/.test(value.receivingAccountHash) ||
      !(value.expiresAt instanceof Date) || !Number.isFinite(value.expiresAt.getTime())) {
    throw new GdsWalletInvariantError('WALLET_TOPUP_INVALID_INTENT');
  }
}

export interface GdsPayosTopupRequest {
  orderCode: number;
  /** Exact integer VND entered by the buyer; no deduction or exchange rate. */
  amount: number;
  /** Nine ASCII characters: compatible with the strictest PayOS bank memo limit. */
  description: string;
  returnUrl: string;
  cancelUrl: string;
  expiredAt: number;
}

/**
 * Pure input for the server-side PayOS SDK, not a payment link or bank QR.
 * `intent` and URLs MUST come from authenticated server state, never the browser.
 * The allocator must reserve orderCode across both Commerce and GDS in a DB lock.
 */
export function buildGdsPayosTopupRequest(
  intent: GdsPayosTopupIntent,
  urls: { returnUrl: string; cancelUrl: string },
): GdsPayosTopupRequest {
  requireTopup(intent);
  if (intent.status !== 'CREATED') throw new GdsWalletInvariantError('WALLET_TOPUP_INVALID_TRANSITION');
  const orderSuffix = intent.payosOrderCode.toString(36).toUpperCase();
  if (orderSuffix.length > 8) throw new GdsWalletInvariantError('WALLET_TOPUP_ORDER_CODE_TOO_LONG');
  const expiredAt = Math.floor(intent.expiresAt.getTime() / 1000);
  if (!Number.isSafeInteger(expiredAt) || expiredAt <= 0 || expiredAt > 2_147_483_647) {
    throw new GdsWalletInvariantError('WALLET_TOPUP_INVALID_EXPIRY');
  }
  try {
    const success = new URL(urls.returnUrl);
    const cancel = new URL(urls.cancelUrl);
    if (success.protocol !== 'https:' || cancel.protocol !== 'https:' ||
        success.origin !== cancel.origin || success.username || success.password ||
        cancel.username || cancel.password || success.hash || cancel.hash) {
      throw new Error('untrusted redirect');
    }
  } catch {
    throw new GdsWalletInvariantError('WALLET_TOPUP_UNTRUSTED_REDIRECT');
  }
  return {
    orderCode: Number(intent.payosOrderCode), amount: Number(intent.amountMinor),
    description: `G${orderSuffix.padStart(8, '0')}`,
    returnUrl: urls.returnUrl, cancelUrl: urls.cancelUrl, expiredAt,
  };
}

function requirePayosCheckoutUrl(checkoutUrl: string): void {
  try {
    const url = new URL(checkoutUrl);
    if (url.protocol === 'https:' &&
        (url.hostname === 'pay.payos.vn' || url.hostname === 'next.pay.payos.vn') &&
        url.username === '' && url.password === '') return;
  } catch { /* invalid URL */ }
  throw new GdsWalletInvariantError('WALLET_TOPUP_UNTRUSTED_CHECKOUT');
}

/** A valid PayOS link is presentation only. It is NEVER evidence of funding. */
export function attachGdsPayosLink(intent: GdsPayosTopupIntent, link: GdsPayosCreatedLink): GdsPayosTopupIntent {
  requireTopup(intent);
  requirePayosCheckoutUrl(link.checkoutUrl);
  if (!link.paymentLinkId || link.orderCode !== intent.payosOrderCode || link.amountMinor !== intent.amountMinor ||
      link.currency !== 'VND' || link.receivingAccountHash !== intent.receivingAccountHash) {
    throw new GdsWalletInvariantError('WALLET_TOPUP_PAYOS_MISMATCH');
  }
  if (intent.status === 'PENDING_PAYOS' && intent.paymentLinkId === link.paymentLinkId) return intent;
  if (intent.status !== 'CREATED') throw new GdsWalletInvariantError('WALLET_TOPUP_TERMINAL_CONFLICT');
  return { ...intent, status: 'PENDING_PAYOS', paymentLinkId: link.paymentLinkId };
}

/**
 * Call ONLY after SDK signature verification AND collision checks against
 * CommercePaymentAttempt / existing wallet funding claims in a DB transaction.
 * A verified PayOS transfer becomes PAYOS_VERIFIED (collection only), never wallet credit.
 */
export function acceptGdsPayosCollection(intent: GdsPayosTopupIntent, fact: GdsPayosVerifiedCollection): GdsPayosTopupIntent {
  requireTopup(intent);
  if (fact.orderCode !== intent.payosOrderCode || fact.amountMinor !== intent.amountMinor ||
      fact.currency !== 'VND' || fact.providerCode !== '00' ||
      !fact.collectionReference || !fact.paymentLinkId ||
      fact.paymentLinkId !== intent.paymentLinkId ||
      fact.receivingAccountHash !== intent.receivingAccountHash ||
      !Number.isFinite(fact.occurredAt.getTime())) {
    throw new GdsWalletInvariantError('WALLET_TOPUP_PAYOS_MISMATCH');
  }
  if (intent.collectionReference) {
    if (intent.collectionReference === fact.collectionReference) return intent;
    throw new GdsWalletInvariantError('WALLET_TOPUP_DUPLICATE_COLLECTION');
  }
  if (intent.status === 'CANCELLED' || fact.occurredAt.getTime() > intent.expiresAt.getTime()) {
    return { ...intent, status: 'REVIEW', collectionReference: fact.collectionReference };
  }
  if (intent.status !== 'PENDING_PAYOS') throw new GdsWalletInvariantError('WALLET_TOPUP_INVALID_TRANSITION');
  return { ...intent, status: 'PAYOS_VERIFIED', collectionReference: fact.collectionReference };
}

/** Independent partner funding confirmation; no self-issued money from PayOS. */
export function acceptGdsPartnerCredit(intent: GdsPayosTopupIntent, fact: GdsPartnerVerifiedCredit): GdsPayosTopupIntent {
  requireTopup(intent);
  if (!fact.eventId || !fact.partnerTransactionId ||
      fact.amountMinor !== intent.amountMinor || fact.currency !== 'VND' ||
      !intent.collectionReference || fact.sourceCollectionReference !== intent.collectionReference) {
    throw new GdsWalletInvariantError('WALLET_TOPUP_PARTNER_MISMATCH');
  }
  if (intent.status === 'CREDITED' && intent.partnerCreditEventId === fact.eventId) return intent;
  if (intent.status !== 'PAYOS_VERIFIED' && intent.status !== 'PENDING_PARTNER') {
    throw new GdsWalletInvariantError('WALLET_TOPUP_INVALID_TRANSITION');
  }
  return { ...intent, status: 'CREDITED', partnerCreditEventId: fact.eventId };
}

/**
 * One-to-one mirror event: 100,000 VND verified by the wallet partner becomes
 * exactly 100,000 VND GDS, not 99,000 or any client-provided value.
 * Persist atomically with a CREDITED transition, under a per-wallet lock and
 * global unique event/transaction constraints; this pure function writes nothing.
 */
export function toGdsWalletFundingEvent(
  intent: GdsPayosTopupIntent,
  fact: GdsPartnerVerifiedCredit,
): GdsWalletVerifiedEvent {
  if (intent.status !== 'CREDITED' || intent.partnerCreditEventId !== fact.eventId) {
    throw new GdsWalletInvariantError('WALLET_TOPUP_NOT_CREDITED');
  }
  acceptGdsPartnerCredit(intent, fact);
  return {
    providerEventId: fact.eventId,
    providerTransactionId: fact.partnerTransactionId,
    kind: 'FUNDS_CREDITED',
    amountMinor: intent.amountMinor,
    currency: 'VND',
  };
}

export function markGdsTopupAwaitingPartner(intent: GdsPayosTopupIntent): GdsPayosTopupIntent {
  if (intent.status === 'PENDING_PARTNER') return intent;
  if (intent.status !== 'PAYOS_VERIFIED') throw new GdsWalletInvariantError('WALLET_TOPUP_INVALID_TRANSITION');
  return { ...intent, status: 'PENDING_PARTNER' };
}

/** Cancelling the UI/intent cannot cancel a transfer that the bank already sent. */
export function cancelGdsTopup(intent: GdsPayosTopupIntent): GdsPayosTopupIntent {
  if (intent.status === 'CANCELLED') return intent;
  if (intent.status !== 'CREATED' && intent.status !== 'PENDING_PAYOS') {
    throw new GdsWalletInvariantError('WALLET_TOPUP_INVALID_TRANSITION');
  }
  return { ...intent, status: 'CANCELLED' };
}
