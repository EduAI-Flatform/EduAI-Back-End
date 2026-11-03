import { createHash } from 'node:crypto';
import {
  PaymentProvider,
  PaymentRequestStatus,
  VerifiedPaymentWebhook,
} from '../payments/payment-provider';
import { GdsInternalPayosSettlement } from './gds-internal-topup.domain';
import {
  acceptGdsPayosCollection,
  GdsPayosTopupIntent,
} from './gds-payos-topup.domain';
import { GdsWalletInvariantError } from './gds-wallet.domain';
import { isPayosAccount } from '../payments/payos-link.validation';

/**
 * PAYW-04B source-only bridge to EduAI's genuine PayOS SDK adapter.
 * `verifyWebhook` checks the PayOS signature; `reconcilePaymentRequest`
 * makes a second authenticated provider query. Neither a QR nor a browser
 * redirect can produce this result. This function does not mutate storage.
 *
 * The PAYW-04E inbox worker persists verified collection facts, checks the
 * global Commerce/legacy namespace and posts the journal inside one
 * serializable transaction. Production remains hard-disabled.
 */
export interface GdsPayosReconciliationPort {
  provider: Pick<PaymentProvider, 'verifyWebhook' | 'reconcilePaymentRequest'>;
  sandboxEnabled: boolean;
  nodeEnv: string;
  deploymentClass: string;
  now: () => Date;
}

export type GdsPayosReconciliationResult = {
  intent: GdsPayosTopupIntent;
  settlement: GdsInternalPayosSettlement;
};

function reject(code: string): never {
  throw new GdsWalletInvariantError(code);
}

function requireClock(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    reject('GDS_PAYOS_RECONCILIATION_CLOCK');
  }
  return value;
}

function accountHash(account: string | null | undefined): string {
  if (!isPayosAccount(account)) {
    reject('GDS_PAYOS_RECEIVING_ACCOUNT_MISMATCH');
  }
  return createHash('sha256').update(account, 'utf8').digest('hex');
}

function checkVirtualAccount(intent: GdsPayosTopupIntent, account?: string, verifiedHash?: string): void {
  if ((account !== undefined && accountHash(account) !== intent.receivingAccountHash) ||
      (verifiedHash !== undefined && verifiedHash !== intent.receivingAccountHash)) {
    reject('GDS_PAYOS_RECEIVING_ACCOUNT_MISMATCH');
  }
}

function checkVerifiedWebhook(intent: GdsPayosTopupIntent, fact: VerifiedPaymentWebhook): void {
  if (fact.provider !== 'payos' || fact.providerCode !== '00' ||
      fact.providerOrderReference !== intent.payosOrderCode.toString() ||
      fact.localOrderReference !== Number(intent.payosOrderCode) ||
      fact.providerPaymentIdentity !== intent.paymentLinkId ||
      !fact.providerSettlementReference || fact.providerEventIdentity !== fact.providerSettlementReference ||
      fact.amountMinor !== intent.amountMinor || fact.currency !== 'VND' ||
      !(fact.occurredAt instanceof Date) || !Number.isFinite(fact.occurredAt.getTime())) {
    reject('GDS_PAYOS_WEBHOOK_MISMATCH');
  }
  const physicalHash = accountHash(fact.receivingAccount);
  if (intent.settlementReceivingAccountHash != null &&
      intent.settlementReceivingAccountHash !== physicalHash) reject('GDS_PAYOS_RECEIVING_ACCOUNT_MISMATCH');
  checkVirtualAccount(intent, fact.virtualReceivingAccount, fact.verifiedVirtualAccountHash);
}

function checkProviderStatus(intent: GdsPayosTopupIntent, fact: VerifiedPaymentWebhook, status: PaymentRequestStatus): void {
  if (status.status !== 'PAID' || status.providerPaymentIdentity !== intent.paymentLinkId ||
      status.localOrderReference !== Number(intent.payosOrderCode) || status.amountMinor !== intent.amountMinor ||
      status.amountPaidMinor !== intent.amountMinor || status.amountRemainingMinor !== 0n ||
      !(status.createdAt instanceof Date) || !Number.isFinite(status.createdAt.getTime()) ||
      status.transactions.length !== 1) reject('GDS_PAYOS_RECONCILIATION_MISMATCH');
  const physicalHash = accountHash(fact.receivingAccount);
  // GET has no documented root accountNumber. Its single signed transaction
  // identifies the real receiver; compare it to the signed webhook, not the QR VA.
  if (status.receivingAccount != null && accountHash(status.receivingAccount) !== physicalHash) {
    reject('GDS_PAYOS_RECONCILIATION_MISMATCH');
  }
  const transfer = status.transactions[0];
  if (transfer.reference !== fact.providerSettlementReference || transfer.amountMinor !== intent.amountMinor ||
      accountHash(transfer.receivingAccount) !== physicalHash ||
      !(transfer.occurredAt instanceof Date) || !Number.isFinite(transfer.occurredAt.getTime()) ||
      transfer.occurredAt < status.createdAt ||
      (intent.createdAt !== undefined && transfer.occurredAt < intent.createdAt) ||
      transfer.occurredAt.getTime() !== fact.occurredAt.getTime()) {
    reject('GDS_PAYOS_RECONCILIATION_MISMATCH');
  }
  checkVirtualAccount(intent, transfer.virtualReceivingAccount);
}

export async function verifyAndReconcileGdsPayosTopup(
  intent: GdsPayosTopupIntent,
  webhookBody: unknown,
  port: GdsPayosReconciliationPort,
): Promise<GdsPayosReconciliationResult> {
  requireEligibleGdsPayosIntent(intent, port);
  const verified = await port.provider.verifyWebhook({ body: webhookBody, headers: {} });
  return reconcileSignedGdsPayosTopup(intent, verified, port, requireClock(port.now()));
}

/**
 * Worker entry: the verified fact came from the append-only signed inbox,
 * populated ONLY after the existing PayOS SDK signature check succeeds.
 * Re-query the provider each attempt: a webhook alone must not mint value.
 */
function requireEligibleGdsPayosIntent(intent: GdsPayosTopupIntent, port: GdsPayosReconciliationPort): void {
  if (!port.sandboxEnabled ||
      (port.nodeEnv !== 'test' && port.nodeEnv !== 'development') ||
      port.deploymentClass !== 'uat') {
    reject('GDS_PAYOS_RECONCILIATION_DISABLED');
  }
  if (!intent.id || !intent.buyerId || !intent.paymentLinkId ||
      !['PENDING_PAYOS', 'PAYOS_VERIFIED', 'CREDITED'].includes(intent.status) ||
      intent.currency !== 'VND' ||
      typeof intent.payosOrderCode !== 'bigint' ||
      intent.payosOrderCode <= 0n ||
      intent.payosOrderCode > BigInt(Number.MAX_SAFE_INTEGER) ||
      typeof intent.amountMinor !== 'bigint' || intent.amountMinor <= 0n ||
      intent.amountMinor > BigInt(Number.MAX_SAFE_INTEGER) ||
      !/^[a-f0-9]{64}$/.test(intent.receivingAccountHash) ||
      !(intent.expiresAt instanceof Date) ||
      !Number.isFinite(intent.expiresAt.getTime())) {
    reject('GDS_PAYOS_RECONCILIATION_INVALID_INTENT');
  }
}

export async function reconcileSignedGdsPayosTopup(
  intent: GdsPayosTopupIntent,
  verified: VerifiedPaymentWebhook,
  port: GdsPayosReconciliationPort,
  signatureVerifiedAt: Date,
): Promise<GdsPayosReconciliationResult> {
  requireEligibleGdsPayosIntent(intent, port);
  const paymentLinkId = intent.paymentLinkId;
  if (!paymentLinkId) reject('GDS_PAYOS_RECONCILIATION_INVALID_INTENT');

  const verifiedAt = requireClock(signatureVerifiedAt);
  const now = requireClock(port.now());
  checkVerifiedWebhook(intent, verified);

  if (verified.occurredAt > intent.expiresAt ||
      verified.occurredAt.getTime() > now.getTime() + 5 * 60_000) {
    reject('GDS_PAYOS_RECONCILIATION_REVIEW');
  }
  const queried = await port.provider.reconcilePaymentRequest(paymentLinkId);
  checkProviderStatus(intent, verified, queried);

  const providerReconciledAt = requireClock(port.now());
  if (providerReconciledAt < verifiedAt) reject('GDS_PAYOS_RECONCILIATION_CLOCK');
  const physicalHash = accountHash(verified.receivingAccount);
  const nextIntent = acceptGdsPayosCollection(intent, {
    orderCode: intent.payosOrderCode,
    amountMinor: intent.amountMinor,
    currency: 'VND',
    paymentLinkId,
    collectionReference: verified.providerSettlementReference,
    receivingAccountHash: intent.receivingAccountHash,
    occurredAt: verified.occurredAt,
    providerCode: '00',
  });
  if (nextIntent.status !== 'PAYOS_VERIFIED' && nextIntent.status !== 'CREDITED') reject('GDS_PAYOS_RECONCILIATION_REVIEW');

  return {
    intent: { ...nextIntent, settlementReceivingAccountHash: physicalHash },
    settlement: {
      orderCode: intent.payosOrderCode,
      paymentLinkId,
      amountMinor: intent.amountMinor,
      amountRemainingMinor: 0n,
      currency: 'VND',
      receivingAccountHash: intent.receivingAccountHash,
      settlementReceivingAccountHash: physicalHash,
      collectionReference: verified.providerSettlementReference,
      status: 'PAID',
      signatureVerifiedAt: verifiedAt,
      providerReconciledAt,
    },
  };
}
