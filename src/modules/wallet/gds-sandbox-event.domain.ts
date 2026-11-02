import { createHmac, timingSafeEqual } from 'node:crypto';
import { GdsInternalPayosSettlement } from './gds-internal-topup.domain';
import { GdsWalletInvariantError } from './gds-wallet.domain';

/** PAYW-04B simulation protocol. NEVER a PayOS webhook format or signature. */
export interface GdsSyntheticCollectionEvent {
  source: 'EDUAI_GDS_SYNTHETIC_V1';
  intentId: string;
  orderCode: string;
  paymentLinkId: string;
  amountMinor: string;
  amountRemainingMinor: string;
  currency: 'VND';
  receivingAccountHash: string;
  collectionReference: string;
  providerStatus: 'PAID';
  reconciledAt: string;
}

export interface GdsSandboxEventAuth {
  nodeEnv: 'development' | 'test' | 'production';
  deploymentClass: 'uat' | 'production';
  sandboxEnabled: boolean;
  /** Caller-provided, non-production fixture HMAC key; no default key exists. */
  fixtureKey: string;
  verifiedAt: Date;
}

function invalid(): never {
  throw new GdsWalletInvariantError('GDS_SYNTHETIC_EVENT_REJECTED');
}

function positiveInteger(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)) invalid();
  const number = BigInt(value);
  if (number > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  return number;
}

/**
 * Authenticates a synthetic, locally generated test fact and maps it to the
 * verified/reconciled candidate shape. This is NOT PayOS authentication, does
 * NOT initiate a transfer, and is not registered as a controller or webhook.
 * Production is forbidden even when a caller supplies a fixture secret.
 */
export function verifyGdsSyntheticCollectionEvent(
  rawBody: Buffer,
  signatureHex: string,
  auth: GdsSandboxEventAuth,
): { intentId: string; settlement: GdsInternalPayosSettlement } {
  if (!auth.sandboxEnabled || auth.nodeEnv === 'production' ||
      auth.deploymentClass === 'production' ||
      typeof auth.fixtureKey !== 'string' || auth.fixtureKey.length < 32 ||
      !(auth.verifiedAt instanceof Date) || !Number.isFinite(auth.verifiedAt.getTime()) ||
      !Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > 4096 ||
      !/^[a-f0-9]{64}$/i.test(signatureHex)) invalid();

  const calculated = createHmac('sha256', auth.fixtureKey).update(rawBody).digest();
  const supplied = Buffer.from(signatureHex, 'hex');
  if (supplied.length !== calculated.length || !timingSafeEqual(supplied, calculated)) invalid();

  let event: Record<string, unknown>;
  try {
    const decoded = JSON.parse(rawBody.toString('utf8')) as unknown;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) invalid();
    event = decoded as Record<string, unknown>;
  } catch { return invalid(); }

  if (event.source !== 'EDUAI_GDS_SYNTHETIC_V1' || event.providerStatus !== 'PAID' ||
      event.currency !== 'VND' || typeof event.intentId !== 'string' || !event.intentId ||
      typeof event.paymentLinkId !== 'string' || !event.paymentLinkId ||
      typeof event.collectionReference !== 'string' || !event.collectionReference ||
      typeof event.receivingAccountHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(event.receivingAccountHash) ||
      typeof event.reconciledAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(event.reconciledAt)) invalid();

  const orderCode = positiveInteger(event.orderCode);
  const amountMinor = positiveInteger(event.amountMinor);
  if (event.amountRemainingMinor !== '0') invalid();
  const providerReconciledAt = new Date(event.reconciledAt as string);
  if (!Number.isFinite(providerReconciledAt.getTime()) || providerReconciledAt < auth.verifiedAt) invalid();
  return {
    intentId: event.intentId as string,
    settlement: {
      orderCode, paymentLinkId: event.paymentLinkId as string,
      amountMinor, amountRemainingMinor: 0n, currency: 'VND',
      receivingAccountHash: event.receivingAccountHash as string,
      collectionReference: event.collectionReference as string,
      status: 'PAID', signatureVerifiedAt: auth.verifiedAt, providerReconciledAt,
    },
  };
}
