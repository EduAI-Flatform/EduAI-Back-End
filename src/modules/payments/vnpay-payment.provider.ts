import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import {
  CreatePaymentRequestInput,
  CreatedPaymentRequest,
  PaymentProvider,
  PaymentProviderError,
  PaymentReconciliationOptions,
  PaymentRequestStatus,
  VerifiedPaymentWebhook,
  VerifyPaymentWebhookInput,
} from './payment-provider';

export type VnPayEnvironment = 'disabled' | 'sandbox' | 'production';

export interface VnPayProviderConfig {
  environment: VnPayEnvironment;
  tmnCode?: string;
  hashSecret?: string;
  paymentUrl: string;
  returnUrl?: string;
  ipnUrl?: string;
  version: string;
  timeoutMs: number;
}

const VNPAY_AMOUNT_MAX = 999999999999n;
const VN_TIMEZONE_OFFSET_MS = 7 * 60 * 60 * 1000;

export class VnPayPaymentProvider implements PaymentProvider {
  constructor(
    private readonly config: VnPayProviderConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  checkoutUrlFor(_providerPaymentIdentity: string): string | undefined {
    // VNPay URLs include a time-bound signature and cannot be reconstructed
    // from the stored merchant reference alone.
    return undefined;
  }

  async createPaymentRequest(
    input: CreatePaymentRequestInput,
  ): Promise<CreatedPaymentRequest> {
    if (this.config.environment === 'disabled') {
      throw new PaymentProviderError('disabled', false);
    }

    this.validateConfiguration();
    const currentTime = this.now();
    const normalized = validateCreateInput(input, currentTime);
    const params: Record<string, string> = {
      vnp_Version: this.config.version,
      vnp_Command: 'pay',
      vnp_TmnCode: this.config.tmnCode as string,
      vnp_Amount: amountMinorToVnPay(input.amountMinor),
      vnp_CurrCode: 'VND',
      vnp_TxnRef: normalized.providerOrderReference,
      vnp_OrderInfo: input.description,
      vnp_OrderType: 'other',
      vnp_Locale: 'vn',
      vnp_ReturnUrl: input.returnUrls.success,
      vnp_IpAddr: input.clientIpAddress as string,
      vnp_CreateDate: formatVnPayDate(currentTime),
      vnp_ExpireDate: formatVnPayDate(normalized.expiresAt),
    };
    const checkoutUrl = buildVnPaySignedUrl(
      this.config.paymentUrl,
      params,
      this.config.hashSecret as string,
    );

    return {
      providerPaymentIdentity: normalized.providerOrderReference,
      providerOrderReference: normalized.providerOrderReference,
      localOrderReference: normalized.localOrderReference,
      amountMinor: input.amountMinor,
      currency: 'VND',
      status: 'PENDING',
      checkoutUrl,
      expiresAt: normalized.expiresAt,
    };
  }

  async retrievePaymentRequest(_providerPaymentIdentity: string): Promise<PaymentRequestStatus> {
    return this.unsupported();
  }

  async cancelPaymentRequest(
    _providerPaymentIdentity: string,
    _reason?: string,
  ): Promise<PaymentRequestStatus> {
    return this.unsupported();
  }

  async verifyWebhook(_input: VerifyPaymentWebhookInput): Promise<VerifiedPaymentWebhook> {
    return this.unsupported();
  }

  async reconcilePaymentRequest(
    _providerPaymentIdentity: string,
    _options?: PaymentReconciliationOptions,
  ): Promise<PaymentRequestStatus> {
    return this.unsupported();
  }

  private validateConfiguration(): void {
    if (
      !isBoundedString(this.config.tmnCode, 32) ||
      !isBoundedString(this.config.hashSecret, 512) ||
      !isHttpUrl(this.config.paymentUrl) ||
      !isHttpUrl(this.config.returnUrl) ||
      !isHttpUrl(this.config.ipnUrl) ||
      !isBoundedString(this.config.version, 32)
    ) {
      throw new PaymentProviderError('invalid_request', false);
    }
  }

  private unsupported<T>(): Promise<T> {
    return Promise.reject(new PaymentProviderError('unsupported', false));
  }
}

export function amountMinorToVnPay(amountMinor: bigint): string {
  if (amountMinor <= 0n) {
    throw new PaymentProviderError('invalid_request', false);
  }

  const amount = amountMinor * 100n;
  if (amount > VNPAY_AMOUNT_MAX) {
    throw new PaymentProviderError('invalid_request', false);
  }
  return amount.toString();
}

export function formatVnPayDate(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new PaymentProviderError('invalid_request', false);
  }
  const local = new Date(value.getTime() + VN_TIMEZONE_OFFSET_MS);
  return [
    local.getUTCFullYear().toString().padStart(4, '0'),
    (local.getUTCMonth() + 1).toString().padStart(2, '0'),
    local.getUTCDate().toString().padStart(2, '0'),
    local.getUTCHours().toString().padStart(2, '0'),
    local.getUTCMinutes().toString().padStart(2, '0'),
    local.getUTCSeconds().toString().padStart(2, '0'),
  ].join('');
}

export function canonicalizeVnPayParams(
  params: Readonly<Record<string, string>>,
): string {
  return Object.entries(params)
    .filter(([, value]) => value !== '')
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${encodeVnPayComponent(key)}=${encodeVnPayComponent(value)}`)
    .join('&');
}

export function buildVnPaySignedUrl(
  paymentUrl: string,
  params: Readonly<Record<string, string>>,
  hashSecret: string,
): string {
  const canonicalQuery = canonicalizeVnPayParams(params);
  const secureHash = createHmac('sha512', hashSecret)
    .update(canonicalQuery, 'utf8')
    .digest('hex');
  const separator = paymentUrl.includes('?') ? '&' : '?';
  return `${paymentUrl}${separator}${canonicalQuery}&vnp_SecureHash=${secureHash}`;
}

function validateCreateInput(
  input: CreatePaymentRequestInput,
  currentTime: Date,
): { providerOrderReference: string; localOrderReference: number; expiresAt: Date } {
  const providerOrderReference = input.providerOrderReference;
  if (
    !isBoundedString(input.paymentAttemptIdentity, 128) ||
    !/^[1-9]\d{0,15}$/.test(providerOrderReference) ||
    input.currency !== 'VND' ||
    !isBoundedString(input.description, 255) ||
    /[\u0000-\u001f\u007f]/.test(input.description) ||
    !isHttpUrl(input.returnUrls.success) ||
    !input.clientIpAddress ||
    input.clientIpAddress.length > 45 ||
    isIP(input.clientIpAddress) === 0 ||
    input.expiresAt === undefined ||
    !Number.isFinite(input.expiresAt.getTime()) ||
    input.expiresAt.getTime() <= currentTime.getTime()
  ) {
    throw new PaymentProviderError('invalid_request', false);
  }

  const numericReference = Number(providerOrderReference);
  if (
    !Number.isSafeInteger(numericReference) ||
    (input.localOrderReference !== undefined &&
      input.localOrderReference !== numericReference)
  ) {
    throw new PaymentProviderError('invalid_request', false);
  }

  return {
    providerOrderReference,
    localOrderReference: numericReference,
    expiresAt: input.expiresAt,
  };
}

function encodeVnPayComponent(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*~]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    .replace(/%20/g, '+');
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isHttpUrl(value: unknown): value is string {
  if (!isBoundedString(value, 2048)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}
