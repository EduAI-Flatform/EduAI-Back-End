import { createHash } from 'node:crypto';
import { PaymentRequestStatus, VerifiedPaymentWebhook } from './payment-provider';
import { VnPayQueryDrObservation } from './vnpay-payment.provider';

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
    provider: 'payos',
    providerOrderReference: String(attempt.providerOrderCode),
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

export interface VnPayQueryDrAttemptVerificationFacts
  extends PaymentAttemptVerificationFacts {
  createdAt: Date;
}

export function toVerifiedVnPayQueryDrWebhook(
  attempt: VnPayQueryDrAttemptVerificationFacts,
  observation: VnPayQueryDrObservation,
): VerifiedPaymentWebhook | null {
  if (
    observation.provider !== 'vnpay' ||
    observation.trusted !== true ||
    observation.queryRequestStatus !== 'success' ||
    observation.transactionStatus !== 'paid' ||
    observation.responseCode !== '00' ||
    observation.transactionStatusCode !== '00' ||
    !isBoundedNumericReference(observation.providerOrderReference, 16) ||
    !isBoundedNumericReference(observation.providerTransactionIdentity, 15) ||
    attempt.providerOrderCode === null ||
    attempt.providerOrderCode !== BigInt(observation.providerOrderReference) ||
    attempt.providerOrderCode > BigInt(Number.MAX_SAFE_INTEGER) ||
    attempt.providerPaymentIdentity !== observation.providerOrderReference ||
    attempt.currency !== 'VND' ||
    observation.currency !== 'VND' ||
    observation.amountMinor === undefined ||
    observation.amountMinor <= 0n ||
    observation.amountMinor !== attempt.amountMinor ||
    !(attempt.createdAt instanceof Date) ||
    !Number.isFinite(attempt.createdAt.getTime())
  ) {
    return null;
  }

  const occurredAt = observation.paidAt ?? attempt.createdAt;
  if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) {
    return null;
  }

  const eventSource = [
    'vnpay-querydr-event-v1',
    observation.providerOrderReference,
    observation.providerTransactionIdentity,
    observation.amountMinor.toString(),
    observation.responseCode,
    observation.transactionStatusCode,
  ].join('|');

  return {
    provider: 'vnpay',
    providerOrderReference: observation.providerOrderReference,
    providerEventIdentity: `vnpay:${createHash('sha256')
      .update(eventSource, 'utf8')
      .digest('hex')}`,
    providerPaymentIdentity: observation.providerOrderReference,
    providerSettlementReference: observation.providerTransactionIdentity as string,
    localOrderReference: Number(observation.providerOrderReference),
    amountMinor: observation.amountMinor,
    currency: 'VND',
    occurredAt,
    ...(observation.paidAt
      ? {}
      : { occurredAtSource: 'receipt' as const }),
    providerCode: observation.responseCode,
    responseCode: observation.responseCode,
    transactionStatus: observation.transactionStatusCode,
  };
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isBoundedNumericReference(
  value: unknown,
  maximumDigits: number,
): value is string {
  return (
    typeof value === 'string' &&
    new RegExp(`^[1-9]\\d{0,${maximumDigits - 1}}$`).test(value)
  );
}
