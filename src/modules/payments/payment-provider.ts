export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export type PaymentProviderErrorCode =
  | 'disabled'
  | 'invalid_request'
  | 'invalid_signature'
  | 'malformed_response'
  | 'rejected'
  | 'timeout'
  | 'unavailable';

export type PaymentProviderStatus =
  | 'PENDING'
  | 'CANCELLED'
  | 'UNDERPAID'
  | 'PAID'
  | 'EXPIRED'
  | 'PROCESSING'
  | 'FAILED';

export class PaymentProviderError extends Error {
  readonly name = 'PaymentProviderError';

  constructor(
    readonly code: PaymentProviderErrorCode,
    readonly retryable: boolean,
  ) {
    super('Payment provider operation failed');
  }
}

export interface CreatePaymentRequestInput {
  paymentAttemptIdentity: string;
  localOrderReference: number;
  amountMinor: bigint;
  currency: 'VND';
  description: string;
  returnUrls: { success: string; cancel: string };
  expiresAt?: Date;
}

export interface CreatedPaymentRequest {
  providerPaymentIdentity: string;
  localOrderReference: number;
  amountMinor: bigint;
  currency: 'VND';
  status: PaymentProviderStatus;
  checkoutUrl: string;
  qrPayload: string;
  expiresAt?: Date;
}

export interface PaymentRequestStatus {
  providerPaymentIdentity: string;
  localOrderReference: number;
  amountMinor: bigint;
  amountPaidMinor: bigint;
  amountRemainingMinor: bigint;
  status: PaymentProviderStatus;
  createdAt: Date;
  cancelledAt?: Date;
}

export interface VerifyPaymentWebhookInput {
  body: unknown;
  headers: Readonly<Record<string, string | undefined>>;
}

export interface VerifiedPaymentWebhook {
  providerEventIdentity: string;
  providerPaymentIdentity: string;
  providerSettlementReference: string;
  localOrderReference: number;
  amountMinor: bigint;
  currency: 'VND';
  occurredAt: Date;
  providerCode: string;
}

export interface PaymentProvider {
  createPaymentRequest(input: CreatePaymentRequestInput): Promise<CreatedPaymentRequest>;
  retrievePaymentRequest(providerPaymentIdentity: string): Promise<PaymentRequestStatus>;
  cancelPaymentRequest(
    providerPaymentIdentity: string,
    reason?: string,
  ): Promise<PaymentRequestStatus>;
  verifyWebhook(input: VerifyPaymentWebhookInput): Promise<VerifiedPaymentWebhook>;
  reconcilePaymentRequest(providerPaymentIdentity: string): Promise<PaymentRequestStatus>;
}
