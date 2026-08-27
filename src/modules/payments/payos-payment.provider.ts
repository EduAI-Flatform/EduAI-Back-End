import {
  APIError,
  ConnectionError,
  ConnectionTimeoutError,
  InvalidSignatureError,
  WebhookError,
} from '@payos/node';
import {
  CreatePaymentRequestInput,
  CreatedPaymentRequest,
  PaymentProvider,
  PaymentProviderError,
  PaymentProviderStatus,
  PaymentRequestStatus,
  VerifiedPaymentWebhook,
  VerifyPaymentWebhookInput,
} from './payment-provider';

export interface PayosClientPort {
  paymentRequests: {
    create(input: object, options: { maxRetries: 0 }): Promise<unknown>;
    get(identity: string, options: { maxRetries: 0 }): Promise<unknown>;
    cancel(
      identity: string,
      reason: string | undefined,
      options: { maxRetries: 0 },
    ): Promise<unknown>;
  };
  webhooks: { verify(body: object): Promise<unknown> };
}

const STATUSES = new Set<PaymentProviderStatus>([
  'PENDING',
  'CANCELLED',
  'UNDERPAID',
  'PAID',
  'EXPIRED',
  'PROCESSING',
  'FAILED',
]);

export class PayosPaymentProvider implements PaymentProvider {
  constructor(private readonly client: PayosClientPort | null) {}

  async createPaymentRequest(
    input: CreatePaymentRequestInput,
  ): Promise<CreatedPaymentRequest> {
    const client = this.requireClient();
    validateCreateInput(input);

    try {
      const response = await client.paymentRequests.create(
        {
          amount: Number(input.amountMinor),
          cancelUrl: input.returnUrls.cancel,
          description: input.description,
          ...(input.expiresAt
            ? { expiredAt: Math.floor(input.expiresAt.getTime() / 1000) }
            : {}),
          orderCode: input.localOrderReference,
          returnUrl: input.returnUrls.success,
        },
        { maxRetries: 0 },
      );
      const normalized = normalizeCreated(response);
      if (
        normalized.localOrderReference !== input.localOrderReference ||
        normalized.amountMinor !== input.amountMinor ||
        normalized.currency !== input.currency
      ) {
        throw new PaymentProviderError('malformed_response', false);
      }
      return normalized;
    } catch (error) {
      throw mapProviderError(error);
    }
  }

  async retrievePaymentRequest(identity: string): Promise<PaymentRequestStatus> {
    return this.getPaymentRequest(identity);
  }

  async cancelPaymentRequest(
    identity: string,
    reason?: string,
  ): Promise<PaymentRequestStatus> {
    const client = this.requireClient();
    validateIdentity(identity);
    if (reason !== undefined && (reason.length < 1 || reason.length > 160)) {
      throw new PaymentProviderError('invalid_request', false);
    }

    try {
      return normalizeStatus(
        await client.paymentRequests.cancel(identity, reason, { maxRetries: 0 }),
      );
    } catch (error) {
      throw mapProviderError(error);
    }
  }

  async verifyWebhook(
    input: VerifyPaymentWebhookInput,
  ): Promise<VerifiedPaymentWebhook> {
    const client = this.requireClient();
    if (
      !isRecord(input.body) ||
      !isRecord(input.body.data) ||
      !isString(input.body.signature, 256)
    ) {
      throw new PaymentProviderError('malformed_response', false);
    }

    try {
      return normalizeWebhook(await client.webhooks.verify(input.body));
    } catch (error) {
      throw mapProviderError(error);
    }
  }

  async reconcilePaymentRequest(identity: string): Promise<PaymentRequestStatus> {
    return this.getPaymentRequest(identity);
  }

  private async getPaymentRequest(identity: string): Promise<PaymentRequestStatus> {
    const client = this.requireClient();
    validateIdentity(identity);

    try {
      return normalizeStatus(
        await client.paymentRequests.get(identity, { maxRetries: 0 }),
      );
    } catch (error) {
      throw mapProviderError(error);
    }
  }

  private requireClient(): PayosClientPort {
    if (!this.client) throw new PaymentProviderError('disabled', false);
    return this.client;
  }
}

function validateCreateInput(input: CreatePaymentRequestInput): void {
  if (
    input.currency !== 'VND' ||
    input.amountMinor <= 0n ||
    input.amountMinor > BigInt(Number.MAX_SAFE_INTEGER) ||
    !Number.isSafeInteger(input.localOrderReference) ||
    input.localOrderReference <= 0 ||
    input.description.length < 1 ||
    input.description.length > 25 ||
    !isHttpUrl(input.returnUrls.success) ||
    !isHttpUrl(input.returnUrls.cancel) ||
    !isString(input.paymentAttemptIdentity, 128) ||
    (input.expiresAt !== undefined && !Number.isFinite(input.expiresAt.getTime()))
  ) {
    throw new PaymentProviderError('invalid_request', false);
  }
}

function validateIdentity(identity: string): void {
  if (!isString(identity, 128)) {
    throw new PaymentProviderError('invalid_request', false);
  }
}

function normalizeCreated(value: unknown): CreatedPaymentRequest {
  const item = requireRecord(value);
  const status = requireStatus(item.status);
  const currency = requireVnd(item.currency);
  const checkoutUrl = requireHttpsUrl(item.checkoutUrl);

  return {
    providerPaymentIdentity: requireString(item.paymentLinkId, 128),
    localOrderReference: requireSafeInteger(item.orderCode),
    amountMinor: BigInt(requireNonNegativeInteger(item.amount)),
    currency,
    status,
    checkoutUrl,
    qrPayload: requireString(item.qrCode, 8192),
    receivingAccount: requireString(item.accountNumber, 128),
    ...(item.expiredAt === undefined
      ? {}
      : { expiresAt: requireUnixDate(item.expiredAt) }),
  };
}

function normalizeStatus(value: unknown): PaymentRequestStatus {
  const item = requireRecord(value);
  const amountMinor = BigInt(requireNonNegativeInteger(item.amount));
  const amountPaidMinor = BigInt(requireNonNegativeInteger(item.amountPaid));
  const amountRemainingMinor = BigInt(requireNonNegativeInteger(item.amountRemaining));
  return {
    providerPaymentIdentity: requireString(item.id, 128),
    receivingAccount: requireString(item.accountNumber, 128),
    localOrderReference: requireSafeInteger(item.orderCode),
    amountMinor,
    amountPaidMinor,
    amountRemainingMinor,
    status: requireStatus(item.status),
    createdAt: requireIsoDate(item.createdAt),
    transactions: requireTransactions(item.transactions),
    ...(item.canceledAt === null
      ? {}
      : { cancelledAt: requireIsoDate(item.canceledAt) }),
  };
}

function requireTransactions(value: unknown): PaymentRequestStatus['transactions'] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new PaymentProviderError('malformed_response', false);
  }
  return value.map((candidate) => {
    const item = requireRecord(candidate);
    return {
      reference: requireString(item.reference, 128),
      amountMinor: BigInt(requireNonNegativeInteger(item.amount)),
      receivingAccount: requireString(item.accountNumber, 128),
      occurredAt: requireProviderDate(item.transactionDateTime),
    };
  });
}

function normalizeWebhook(value: unknown): VerifiedPaymentWebhook {
  const item = requireRecord(value);
  const reference = requireString(item.reference, 128);
  return {
    providerEventIdentity: reference,
    providerPaymentIdentity: requireString(item.paymentLinkId, 128),
    providerSettlementReference: reference,
    localOrderReference: requireSafeInteger(item.orderCode),
    amountMinor: BigInt(requireNonNegativeInteger(item.amount)),
    currency: requireVnd(item.currency),
    occurredAt: requireProviderDate(item.transactionDateTime),
    providerCode: requireString(item.code, 32),
    receivingAccount: requireString(item.accountNumber, 128),
  };
}

function mapProviderError(error: unknown): PaymentProviderError {
  if (error instanceof PaymentProviderError) return error;
  if (error instanceof ConnectionTimeoutError) {
    return new PaymentProviderError('timeout', true);
  }
  if (error instanceof InvalidSignatureError) {
    return new PaymentProviderError('invalid_signature', false);
  }
  if (error instanceof WebhookError) {
    return new PaymentProviderError('invalid_signature', false);
  }
  if (error instanceof ConnectionError) {
    return new PaymentProviderError('unavailable', true);
  }
  if (error instanceof APIError) {
    const retryable =
      error.status === 429 ||
      (typeof error.status === 'number' && error.status >= 500);
    return new PaymentProviderError(retryable ? 'unavailable' : 'rejected', retryable);
  }
  return new PaymentProviderError('unavailable', true);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new PaymentProviderError('malformed_response', false);
  }
  return value;
}

function requireString(value: unknown, maximum: number): string {
  if (!isString(value, maximum)) {
    throw new PaymentProviderError('malformed_response', false);
  }
  return value;
}

function requireSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new PaymentProviderError('malformed_response', false);
  }
  return value as number;
}

function requireNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PaymentProviderError('malformed_response', false);
  }
  return value as number;
}

function requireStatus(value: unknown): PaymentProviderStatus {
  if (typeof value !== 'string' || !STATUSES.has(value as PaymentProviderStatus)) {
    throw new PaymentProviderError('malformed_response', false);
  }
  return value as PaymentProviderStatus;
}

function requireVnd(value: unknown): 'VND' {
  if (value !== 'VND') throw new PaymentProviderError('malformed_response', false);
  return value;
}

function requireHttpsUrl(value: unknown): string {
  const url = requireString(value, 2048);
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      throw new Error();
    }
  } catch {
    throw new PaymentProviderError('malformed_response', false);
  }
  return url;
}

function requireIsoDate(value: unknown): Date {
  const raw = requireString(value, 64);
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) {
    throw new PaymentProviderError('malformed_response', false);
  }
  return date;
}

function requireProviderDate(value: unknown): Date {
  const raw = requireString(value, 64);
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? raw.replace(' ', 'T') + '+07:00'
    : raw;
  return requireIsoDate(normalized);
}

function requireUnixDate(value: unknown): Date {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new PaymentProviderError('malformed_response', false);
  }
  return new Date((value as number) * 1000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
