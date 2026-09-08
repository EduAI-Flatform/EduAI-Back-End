import { PaymentRequestStatus, VerifiedPaymentWebhook } from './payment-provider';

export interface PaymentAttemptVerificationFacts {
  providerPaymentIdentity: string | null;
  providerOrderCode: bigint | null;
  amountMinor: bigint;
  currency: string;
}

export function toVerifiedPaymentWebhook(
  attempt: PaymentAttemptVerificationFacts,
  status: PaymentRequestStatus,
): VerifiedPaymentWebhook | null {
  if (
    status.status !== 'PAID' ||
    !isBoundedString(status.providerPaymentIdentity, 128) ||
    (attempt.providerPaymentIdentity !== null &&
      attempt.providerPaymentIdentity !== status.providerPaymentIdentity) ||
    !Number.isSafeInteger(status.localOrderReference) ||
    status.localOrderReference <= 0 ||
    attempt.providerOrderCode === null ||
    attempt.providerOrderCode !== BigInt(status.localOrderReference) ||
    attempt.providerOrderCode > BigInt(Number.MAX_SAFE_INTEGER) ||
    attempt.currency !== 'VND' ||
    status.amountMinor !== attempt.amountMinor ||
    status.amountPaidMinor !== attempt.amountMinor ||
    status.amountRemainingMinor !== 0n ||
    !Array.isArray(status.transactions)
  ) {
    return null;
  }

  const transaction = status.transactions.find(
    (candidate) =>
      candidate.amountMinor === attempt.amountMinor &&
      isBoundedString(candidate.reference, 128) &&
      isBoundedString(candidate.receivingAccount, 128) &&
      candidate.occurredAt instanceof Date &&
      Number.isFinite(candidate.occurredAt.getTime()),
  );
  if (!transaction) return null;

  return {
    providerEventIdentity: transaction.reference,
    providerPaymentIdentity: status.providerPaymentIdentity,
    providerSettlementReference: transaction.reference,
    localOrderReference: Number(attempt.providerOrderCode),
    amountMinor: transaction.amountMinor,
    currency: 'VND',
    occurredAt: transaction.occurredAt,
    providerCode: '00',
    receivingAccount: transaction.receivingAccount,
  };
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}
