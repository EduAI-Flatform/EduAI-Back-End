import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import {
  PaymentWebhookProcessingResult,
  PaymentWebhookService,
} from './payment-webhook.service';
import { VerifiedPaymentWebhook } from './payment-provider';
import {
  canonicalizeVnPayIpnParams,
  verifyVnPaySignature,
  VNPAY_AMOUNT_MAX,
} from './vnpay-payment.provider';

export interface VnPayIpnResponse {
  RspCode: '00' | '01' | '02' | '04' | '97' | '99';
  Message: string;
}

type VnPayIpnErrorCode = 'request' | 'amount' | 'currency' | 'merchant';

class VnPayIpnValidationError extends Error {
  constructor(readonly code: VnPayIpnErrorCode) {
    super('VNPAY IPN validation failed');
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const MAX_PARAMETER_COUNT = 32;
const MAX_PARAMETER_VALUE_LENGTH = 2_048;
const MAX_EVENT_IDENTITY_INPUT_LENGTH = 16_384;
const VNPAY_IPN_KEYS = new Set([
  'vnp_Version',
  'vnp_Command',
  'vnp_TmnCode',
  'vnp_Amount',
  'vnp_BankCode',
  'vnp_BankTranNo',
  'vnp_CardType',
  'vnp_OrderInfo',
  'vnp_PayDate',
  'vnp_ResponseCode',
  'vnp_TxnRef',
  'vnp_TransactionNo',
  'vnp_TransactionStatus',
  'vnp_SecureHashType',
  'vnp_SecureHash',
  'vnp_CurrCode',
  'vnp_CreateDate',
  'vnp_ExpireDate',
  'vnp_IpAddr',
  'vnp_Locale',
  'vnp_OrderType',
  'vnp_ReturnUrl',
  'vnp_TransactionType',
]);

const RESPONSE_MESSAGES: Record<VnPayIpnResponse['RspCode'], string> = {
  '00': 'Confirm Success',
  '01': 'Order not found',
  '02': 'Order already confirmed',
  '04': 'Invalid amount',
  '97': 'Invalid signature',
  '99': 'Invalid request',
};

@Injectable()
export class VnPayIpnService {
  constructor(
    private readonly config: AppConfigService,
    private readonly webhook: PaymentWebhookService,
  ) {}

  async handle(query: unknown): Promise<VnPayIpnResponse> {
    const providerConfig = this.config.vnpay;
    if (
      providerConfig.environment === 'disabled' ||
      !providerConfig.tmnCode ||
      !providerConfig.hashSecret
    ) {
      return response('99');
    }

    let params: Record<string, string>;
    try {
      params = parseVnPayIpnQuery(query);
    } catch {
      return response('99');
    }

    const secureHash = params.vnp_SecureHash;
    if (
      !secureHash ||
      !verifyVnPaySignature(params, secureHash, providerConfig.hashSecret)
    ) {
      return response('97');
    }

    try {
      const verified = normalizeVnPayIpn(params, {
        tmnCode: providerConfig.tmnCode,
        version: providerConfig.version,
      });

      if (
        verified.responseCode !== '00' ||
        verified.transactionStatus !== '00'
      ) {
        const classification = await this.webhook.classifyVerified(verified);
        if (classification === 'UNKNOWN') return response('01');
        if (classification === 'INVALID_AMOUNT') return response('04');
        if (classification === 'ALREADY_CONFIRMED') return response('02');
        if (classification === 'INVALID_IDENTITY') return response('99');
        return response('00');
      }

      return this.mapProcessingResult(await this.webhook.processVerified(verified));
    } catch (error) {
      if (error instanceof VnPayIpnValidationError) {
        if (error.code === 'amount' || error.code === 'currency') {
          return response('04');
        }
        return response('99');
      }
      return response('99');
    }
  }

  private mapProcessingResult(
    result: PaymentWebhookProcessingResult,
  ): VnPayIpnResponse {
    if ('rejected' in result) {
      return result.error === 'PAYMENT_FACT_MISMATCH'
        ? response('04')
        : response('99');
    }
    if (result.result === 'UNKNOWN_PAYMENT_ACKNOWLEDGED') {
      return response('01');
    }
    if (result.replayed) return response('02');
    return response('00');
  }
}

export function parseVnPayIpnQuery(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new VnPayIpnValidationError('request');
  }

  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_PARAMETER_COUNT) {
    throw new VnPayIpnValidationError('request');
  }

  const params: Record<string, string> = {};
  let totalLength = 0;
  for (const [key, value] of entries) {
    if (!VNPAY_IPN_KEYS.has(key) || !/^vnp_[A-Za-z]+$/.test(key)) {
      throw new VnPayIpnValidationError('request');
    }
    if (typeof value !== 'string') {
      throw new VnPayIpnValidationError('request');
    }
    if (value.length > MAX_PARAMETER_VALUE_LENGTH) {
      throw new VnPayIpnValidationError('request');
    }
    totalLength += key.length + value.length;
    if (totalLength > MAX_EVENT_IDENTITY_INPUT_LENGTH) {
      throw new VnPayIpnValidationError('request');
    }
    params[key] = value;
  }
  return params;
}

export function isWellFormedVnPayQueryEncoding(url: string | undefined): boolean {
  if (url === undefined) return true;
  if (url.length > MAX_EVENT_IDENTITY_INPUT_LENGTH) return false;
  const query = url.split('?', 2)[1]?.split('#', 1)[0] ?? '';
  try {
    decodeURIComponent(query.replace(/\+/g, ' '));
    return true;
  } catch {
    return false;
  }
}

export function normalizeVnPayIpn(
  params: Readonly<Record<string, string>>,
  expected: { tmnCode: string; version: string },
): VerifiedPaymentWebhook {
  const tmnCode = required(params, 'vnp_TmnCode', 32, /^[A-Za-z0-9]+$/);
  if (tmnCode !== expected.tmnCode) {
    throw new VnPayIpnValidationError('merchant');
  }
  if (
    params.vnp_Version !== undefined &&
    params.vnp_Version !== expected.version
  ) {
    throw new VnPayIpnValidationError('request');
  }
  if (params.vnp_Command !== undefined && params.vnp_Command !== 'pay') {
    throw new VnPayIpnValidationError('request');
  }
  if (
    params.vnp_CurrCode !== undefined &&
    params.vnp_CurrCode !== 'VND'
  ) {
    throw new VnPayIpnValidationError('currency');
  }

  const transactionReference = required(
    params,
    'vnp_TxnRef',
    100,
    /^[1-9]\d{0,15}$/,
  );
  const localOrderReference = Number(transactionReference);
  if (!Number.isSafeInteger(localOrderReference)) {
    throw new VnPayIpnValidationError('request');
  }

  const amountMinor = parseAmount(params.vnp_Amount);
  const transactionNo = required(
    params,
    'vnp_TransactionNo',
    15,
    /^[1-9]\d{0,14}$/,
  );
  const responseCode = required(params, 'vnp_ResponseCode', 2, /^\d{2}$/);
  const transactionStatus = required(
    params,
    'vnp_TransactionStatus',
    2,
    /^\d{2}$/,
  );
  required(params, 'vnp_BankCode', 20, /^[A-Za-z0-9_-]{3,20}$/);
  required(params, 'vnp_OrderInfo', 255, (value) => value.length > 0);

  const payDate = params.vnp_PayDate
    ? parseVnPayDate(params.vnp_PayDate)
    : undefined;
  if (params.vnp_PayDate !== undefined && !payDate) {
    throw new VnPayIpnValidationError('request');
  }

  const canonical = canonicalizeVnPayIpnParams(params);
  if (canonical.length > MAX_EVENT_IDENTITY_INPUT_LENGTH) {
    throw new VnPayIpnValidationError('request');
  }

  return {
    provider: 'vnpay',
    providerOrderReference: transactionReference,
    providerEventIdentity: `vnpay:${createHash('sha256')
      .update(`vnpay-ipn-event:${canonical}`, 'utf8')
      .digest('hex')}`,
    providerPaymentIdentity: transactionReference,
    providerSettlementReference: transactionNo,
    localOrderReference,
    amountMinor,
    currency: 'VND',
    occurredAt: payDate ?? new Date(),
    ...(payDate ? {} : { occurredAtSource: 'receipt' as const }),
    providerCode: responseCode,
    responseCode,
    transactionStatus,
  };
}

function parseAmount(value: string | undefined): bigint {
  if (!value || !/^\d{1,12}$/.test(value)) {
    throw new VnPayIpnValidationError('amount');
  }
  let amount: bigint;
  try {
    amount = BigInt(value);
  } catch {
    throw new VnPayIpnValidationError('amount');
  }
  if (amount <= 0n || amount > VNPAY_AMOUNT_MAX || amount % 100n !== 0n) {
    throw new VnPayIpnValidationError('amount');
  }
  const amountMinor = amount / 100n;
  if (amountMinor <= 0n) throw new VnPayIpnValidationError('amount');
  return amountMinor;
}

function parseVnPayDate(value: string): Date | undefined {
  if (!/^\d{14}$/.test(value)) return undefined;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  if (
    year < 2000 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second) -
    7 * 60 * 60 * 1000;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return undefined;
  const local = new Date(timestamp + 7 * 60 * 60 * 1000);
  return (
    local.getUTCFullYear() === year &&
    local.getUTCMonth() + 1 === month &&
    local.getUTCDate() === day &&
    local.getUTCHours() === hour &&
    local.getUTCMinutes() === minute &&
    local.getUTCSeconds() === second
  )
    ? date
    : undefined;
}

function required(
  params: Readonly<Record<string, string>>,
  key: string,
  maximum: number,
  pattern: RegExp | ((value: string) => boolean),
): string {
  const value = params[key];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    (pattern instanceof RegExp ? !pattern.test(value) : !pattern(value))
  ) {
    throw new VnPayIpnValidationError(key === 'vnp_Amount' ? 'amount' : 'request');
  }
  return value;
}

function response(code: VnPayIpnResponse['RspCode']): VnPayIpnResponse {
  return { RspCode: code, Message: RESPONSE_MESSAGES[code] };
}
