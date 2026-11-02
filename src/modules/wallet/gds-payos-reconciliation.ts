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

/**
 * PAYW-04B source-only bridge to EduAI's genuine PayOS SDK adapter.
 * `verifyWebhook` checks the PayOS signature; `reconcilePaymentRequest`
 * makes a second authenticated provider query. Neither a QR nor a browser
 * redirect can produce this result. This function does not mutate storage.
 *
 * Still required before *any* future credit: an atomic DB check that the
 * order code, PayOS link, collection reference and buyer are not owned by
 * Commerce or another GDS topup; persisted verification timestamps; and
 * the journal's serializable exactly-once posting. No HTTP route invokes it.
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
  if (typeof account !== 'string' || !/^[0-9]{6,32}$/.test(account)) {
    reject('GDS_PAYOS_RECEIVING_ACCOUNT_MISMATCH');
  }
  return createHash('sha256').update(account, 'utf8').digest('hex');
}

function checkVerifiedWebhook(
  intent: GdsPayosTopupIntent,
  fact: VerifiedPaymentWebhook,
): void {
  if (fact.provider !== 'payos' || fact.providerCode !== '00' ||
      fact.providerOrderReference !== intent.payosOrderCode.toString() ||
      fact.localOrderReference !== Number(intent.payosOrderCode) ||
      fact.providerPaymentIdentity !== intent.paymentLinkId ||
      !fact.providerSettlementReference ||
      fact.providerEventIdentity !== fact.providerSettlementReference ||
      fact.amountMinor !== intent.amountMinor || fact.currency !== 'VND' ||
      accountHash(fact.receivingAccount) !== intent.receivingAccountHash ||
      !(fact.occurredAt instanceof Date) || !Number.isFinite(fact.occurredAt.getTime())) {
    reject('GDS_PAYOS_WEBHOOK_MISMATCH');
  }
}

function checkProviderStatus(
  intent: GdsPayosTopupIntent,
  fact: VerifiedPaymentWebhook,
  status: PaymentRequestStatus,
): void {
  if (status.status !== 'PAID' ||
      status.providerPaymentIdentity !== intent.paymentLinkId ||
      status.localOrderReference !== Number(intent.payosOrderCode) ||
      status.amountMinor !== intent.amountMinor ||
      status.amountPaidMinor !== intent.amountMinor ||
      status.amountRemainingMinor !== 0n ||
      !(status.createdAt instanceof Date) ||
      !Number.isFinite(status.createdAt.getTime()) ||
      accountHash(status.receivingAccount) !== intent.receivingAccountHash ||
      status.transactions.length !== 1) {
    reject('GDS_PAYOS_RECONCILIATION_MISMATCH');
  }

  // A multi-transfer/overpayment case is not an exact 1:1 wallet credit.
  // Require a single provider-confirmed bank transfer matching the signed
  // event; otherwise route to manual reconciliation, never auto-credit.
  const transfer = status.transactions[0];
  if (transfer.reference !== fact.providerSettlementReference ||
      transfer.amountMinor !== intent.amountMinor ||
      accountHash(transfer.receivingAccount) !== intent.receivingAccountHash ||
      !(transfer.occurredAt instanceof Date) ||
      !Number.isFinite(transfer.occurredAt.getTime()) ||
      transfer.occurredAt < status.createdAt ||
      transfer.occurredAt.getTime() !== fact.occurredAt.getTime()) {
    reject('GDS_PAYOS_RECONCILIATION_MISMATCH');
  }
}

export async function verifyAndReconcileGdsPayosTopup(
  intent: GdsPayosTopupIntent,
  webhookBody: unknown,
  port: GdsPayosReconciliationPort,
): Promise<GdsPayosReconciliationResult> {
  if (!port.sandboxEnabled ||
      (port.nodeEnv !== 'test' && port.nodeEnv !== 'development') ||
      port.deploymentClass !== 'uat') {
    reject('GDS_PAYOS_RECONCILIATION_DISABLED');
  }
  if (!intent.id || !intent.buyerId || !intent.paymentLinkId ||
      (intent.status !== 'PENDING_PAYOS' && intent.status !== 'PAYOS_VERIFIED') ||
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

  const verifiedAt = requireClock(port.now());
  // This invokes @payos/node's checksum-key signature verification through
  // the existing PayosPaymentProvider, not the synthetic GDS HMAC test seam.
  const verified = await port.provider.verifyWebhook({ body: webhookBody, headers: {} });
  checkVerifiedWebhook(intent, verified);

  if (verified.occurredAt > intent.expiresAt ||
      verified.occurredAt.getTime() > verifiedAt.getTime() + 5 * 60_000) {
    reject('GDS_PAYOS_RECONCILIATION_REVIEW');
  }
  const queried = await port.provider.reconcilePaymentRequest(intent.paymentLinkId);
  checkProviderStatus(intent, verified, queried);

  const providerReconciledAt = requireClock(port.now());
  if (providerReconciledAt < verifiedAt) reject('GDS_PAYOS_RECONCILIATION_CLOCK');
  const nextIntent = acceptGdsPayosCollection(intent, {
    orderCode: intent.payosOrderCode,
    amountMinor: intent.amountMinor,
    currency: 'VND',
    paymentLinkId: intent.paymentLinkId,
    collectionReference: verified.providerSettlementReference,
    receivingAccountHash: intent.receivingAccountHash,
    occurredAt: verified.occurredAt,
    providerCode: '00',
  });
  if (nextIntent.status !== 'PAYOS_VERIFIED') reject('GDS_PAYOS_RECONCILIATION_REVIEW');

  return {
    intent: nextIntent,
    settlement: {
      orderCode: intent.payosOrderCode,
      paymentLinkId: intent.paymentLinkId,
      amountMinor: intent.amountMinor,
      amountRemainingMinor: 0n,
      currency: 'VND',
      receivingAccountHash: intent.receivingAccountHash,
      collectionReference: verified.providerSettlementReference,
      status: 'PAID',
      signatureVerifiedAt: verifiedAt,
      providerReconciledAt,
    },
  };
}
