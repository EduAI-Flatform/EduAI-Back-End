import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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
  apiUrl?: string;
  returnUrl?: string;
  ipnUrl?: string;
  version: string;
  timeoutMs: number;
}

export const VNPAY_AMOUNT_MAX = 999999999999n;
const VNPAY_TMN_CODE_PATTERN = /^[A-Za-z0-9]{8}$/;
const VN_TIMEZONE_OFFSET_MS = 7 * 60 * 60 * 1000;
const VNPAY_QUERYDR_RESPONSE_MAX_BYTES = 64 * 1024;

export type VnPayHttpClient = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface VnPayQueryDrAttempt {
  readonly provider: 'vnpay';
  readonly providerOrderCode: bigint;
  readonly amountMinor: bigint;
  readonly currency: 'VND';
  readonly transactionCreatedAt: Date;
  readonly knownTransactionNo?: string;
  readonly requestIpAddress: string;
}

export interface VnPayQueryDrOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export type VnPayQueryDrRequestStatus =
  | 'success'
  | 'not_found'
  | 'duplicate_request'
  | 'provider_error';

export type VnPayQueryDrTransactionStatus =
  | 'paid'
  | 'pending'
  | 'failed'
  | 'reversed'
  | 'refund_processing'
  | 'refund_sent'
  | 'fraud_suspected'
  | 'expired'
  | 'refund_rejected'
  | 'delivered'
  | 'unknown';

export interface VnPayQueryDrObservation {
  readonly provider: 'vnpay';
  readonly queryRequestStatus: VnPayQueryDrRequestStatus;
  readonly transactionStatus: VnPayQueryDrTransactionStatus;
  readonly providerOrderReference: string;
  readonly providerTransactionIdentity?: string;
  readonly amountMinor?: bigint;
  readonly currency: 'VND';
  readonly paidAt?: Date;
  readonly responseCode: string;
  readonly transactionStatusCode?: string;
  readonly trusted: true;
}

export type VnPayQueryDrErrorCode =
  | 'disabled'
  | 'invalid_request'
  | 'network_timeout'
  | 'provider_unavailable'
  | 'malformed_response'
  | 'invalid_response_signature'
  | 'provider_fact_mismatch';

export class VnPayQueryDrError extends Error {
  readonly name = 'VnPayQueryDrError';

  constructor(
    readonly code: VnPayQueryDrErrorCode,
    readonly retryable: boolean,
  ) {
    super('VNPay QueryDR operation failed');
  }
}

export class VnPayPaymentProvider implements PaymentProvider {
  constructor(
    private readonly config: VnPayProviderConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly httpClient: VnPayHttpClient = defaultVnPayHttpClient,
    private readonly queryRequestIdFactory: () => string = createVnPayQueryDrRequestId,
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

  async queryTransaction(
    input: VnPayQueryDrAttempt,
    options?: VnPayQueryDrOptions,
  ): Promise<VnPayQueryDrObservation> {
    if (this.config.environment === 'disabled') {
      throw new VnPayQueryDrError('disabled', false);
    }

    this.validateConfiguration();
    const normalized = validateQueryDrInput(input);
    const requestId = this.queryRequestIdFactory();
    if (!/^[A-Za-z0-9]{1,32}$/.test(requestId)) {
      throw new VnPayQueryDrError('invalid_request', false);
    }

    const body = buildVnPayQueryDrRequest(
      this.config,
      normalized,
      requestId,
      this.now(),
    );
    const response = await this.postQueryDr(body, options);
    return normalizeVnPayQueryDrResponse(
      this.config,
      normalized,
      response,
    );
  }

  private validateConfiguration(): void {
    if (
      !isValidVnPayTmnCode(this.config.tmnCode) ||
      !isBoundedString(this.config.hashSecret, 512) ||
      !isHttpsUrl(this.config.paymentUrl) ||
      !isHttpsUrl(this.config.apiUrl) ||
      !isHttpsUrl(this.config.returnUrl) ||
      !isHttpsUrl(this.config.ipnUrl) ||
      !isBoundedString(this.config.version, 32)
    ) {
      throw new PaymentProviderError('invalid_request', false);
    }
  }

  private async postQueryDr(
    body: Record<string, string>,
    options?: VnPayQueryDrOptions,
  ): Promise<Record<string, string>> {
    const timeoutMs = resolveQueryDrTimeout(this.config.timeoutMs, options?.timeoutMs);
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    options?.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.httpClient(this.config.apiUrl as string, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) {
          throw new VnPayQueryDrError('network_timeout', true);
        }
        throw new VnPayQueryDrError('provider_unavailable', true);
      }

      const contentLength = Number(response.headers.get('content-length'));
      if (
        Number.isFinite(contentLength) &&
        contentLength > VNPAY_QUERYDR_RESPONSE_MAX_BYTES
      ) {
        throw new VnPayQueryDrError('malformed_response', false);
      }

      if (!response.ok) {
        throw new VnPayQueryDrError(
          response.status >= 500 || response.status === 408 || response.status === 429
            ? 'provider_unavailable'
            : 'malformed_response',
          response.status >= 500 || response.status === 408 || response.status === 429,
        );
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
        throw new VnPayQueryDrError('malformed_response', false);
      }

      let responseBody: string;
      try {
        responseBody = await response.text();
      } catch {
        if (controller.signal.aborted) {
          throw new VnPayQueryDrError('network_timeout', true);
        }
        throw new VnPayQueryDrError('provider_unavailable', true);
      }
      if (Buffer.byteLength(responseBody, 'utf8') > VNPAY_QUERYDR_RESPONSE_MAX_BYTES) {
        throw new VnPayQueryDrError('malformed_response', false);
      }

      return parseVnPayQueryDrResponse(responseBody);
    } finally {
      clearTimeout(timeout);
      options?.signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  private unsupported<T>(): Promise<T> {
    return Promise.reject(new PaymentProviderError('unsupported', false));
  }
}

const QUERY_DR_RESPONSE_FIELD_LIMITS: Readonly<Record<string, number>> = {
  vnp_ResponseId: 32,
  vnp_Command: 16,
  vnp_ResponseCode: 2,
  vnp_Message: 255,
  vnp_TmnCode: 32,
  vnp_TxnRef: 100,
  vnp_Amount: 12,
  vnp_BankCode: 20,
  vnp_PayDate: 14,
  vnp_TransactionNo: 15,
  vnp_TransactionType: 2,
  vnp_TransactionStatus: 2,
  vnp_OrderInfo: 255,
  vnp_PromotionCode: 100,
  vnp_PromotionAmount: 12,
  vnp_SecureHash: 128,
};

const QUERY_DR_RESPONSE_FIELDS = Object.keys(QUERY_DR_RESPONSE_FIELD_LIMITS);

const defaultVnPayHttpClient: VnPayHttpClient = (input, init) =>
  globalThis.fetch(input, init);

export function createVnPayQueryDrRequestId(): string {
  return randomBytes(16).toString('hex');
}

export function buildVnPayQueryDrRequestSignatureSource(
  params: Readonly<Record<string, string>>,
): string {
  return [
    params.vnp_RequestId ?? '',
    params.vnp_Version ?? '',
    params.vnp_Command ?? '',
    params.vnp_TmnCode ?? '',
    params.vnp_TxnRef ?? '',
    params.vnp_TransactionDate ?? '',
    params.vnp_CreateDate ?? '',
    params.vnp_IpAddr ?? '',
    params.vnp_OrderInfo ?? '',
  ].join('|');
}

export function signVnPayQueryDrRequest(
  params: Readonly<Record<string, string>>,
  hashSecret: string,
): string {
  return createHmac('sha512', hashSecret)
    .update(buildVnPayQueryDrRequestSignatureSource(params), 'utf8')
    .digest('hex');
}

export function buildVnPayQueryDrResponseSignatureSource(
  params: Readonly<Record<string, string>>,
): string {
  return [
    params.vnp_ResponseId ?? '',
    params.vnp_Command ?? '',
    params.vnp_ResponseCode ?? '',
    params.vnp_Message ?? '',
    params.vnp_TmnCode ?? '',
    params.vnp_TxnRef ?? '',
    params.vnp_Amount ?? '',
    params.vnp_BankCode ?? '',
    params.vnp_PayDate ?? '',
    params.vnp_TransactionNo ?? '',
    params.vnp_TransactionType ?? '',
    params.vnp_TransactionStatus ?? '',
    params.vnp_OrderInfo ?? '',
    params.vnp_PromotionCode ?? '',
    params.vnp_PromotionAmount ?? '',
  ].join('|');
}

export function signVnPayQueryDrResponse(
  params: Readonly<Record<string, string>>,
  hashSecret: string,
): string {
  return createHmac('sha512', hashSecret)
    .update(buildVnPayQueryDrResponseSignatureSource(params), 'utf8')
    .digest('hex');
}

export function verifyVnPayQueryDrResponseSignature(
  params: Readonly<Record<string, string>>,
  secureHash: string,
  hashSecret: string,
): boolean {
  if (!/^[0-9a-f]{128}$/i.test(secureHash) || hashSecret.length === 0) {
    return false;
  }

  const expected = signVnPayQueryDrResponse(params, hashSecret);
  const suppliedBuffer = Buffer.from(secureHash.toLowerCase(), 'ascii');
  const expectedBuffer = Buffer.from(expected, 'ascii');
  return (
    suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
}

export function buildVnPayQueryDrRequest(
  config: VnPayProviderConfig,
  input: VnPayQueryDrAttempt,
  requestId: string,
  queryCreatedAt: Date,
): Record<string, string> {
  const normalized = validateQueryDrInput(input);
  if (!/^[A-Za-z0-9]{1,32}$/.test(requestId)) {
    throw new VnPayQueryDrError('invalid_request', false);
  }
  if (!isValidVnPayTmnCode(config.tmnCode) || !isBoundedString(config.hashSecret, 512)) {
    throw new VnPayQueryDrError('invalid_request', false);
  }

  let createDate: string;
  let transactionDate: string;
  try {
    createDate = formatVnPayDate(queryCreatedAt);
    transactionDate = formatVnPayDate(input.transactionCreatedAt);
  } catch {
    throw new VnPayQueryDrError('invalid_request', false);
  }

  const params: Record<string, string> = {
    vnp_RequestId: requestId,
    vnp_Version: config.version,
    vnp_Command: 'querydr',
    vnp_TmnCode: config.tmnCode,
    vnp_TxnRef: normalized.providerOrderReference,
    vnp_OrderInfo: normalized.orderInfo,
    vnp_TransactionDate: transactionDate,
    vnp_CreateDate: createDate,
    vnp_IpAddr: input.requestIpAddress,
  };
  if (input.knownTransactionNo !== undefined) {
    params.vnp_TransactionNo = input.knownTransactionNo;
  }

  return {
    ...params,
    vnp_SecureHash: signVnPayQueryDrRequest(params, config.hashSecret),
  };
}

function validateQueryDrInput(
  input: VnPayQueryDrAttempt,
): VnPayQueryDrAttempt & { providerOrderReference: string; orderInfo: string } {
  if (
    !input ||
    input.provider !== 'vnpay' ||
    typeof input.providerOrderCode !== 'bigint' ||
    input.providerOrderCode <= 0n ||
    input.providerOrderCode > BigInt(Number.MAX_SAFE_INTEGER) ||
    !/^[1-9]\d{0,15}$/.test(input.providerOrderCode.toString()) ||
    input.currency !== 'VND' ||
    typeof input.amountMinor !== 'bigint' ||
    !isValidDate(input.transactionCreatedAt) ||
    !isBoundedString(input.requestIpAddress, 45) ||
    isIP(input.requestIpAddress) === 0
  ) {
    throw new VnPayQueryDrError('invalid_request', false);
  }

  try {
    amountMinorToVnPay(input.amountMinor);
  } catch {
    throw new VnPayQueryDrError('invalid_request', false);
  }

  if (
    input.knownTransactionNo !== undefined &&
    (!/^\d{1,15}$/.test(input.knownTransactionNo) ||
      BigInt(input.knownTransactionNo) <= 0n)
  ) {
    throw new VnPayQueryDrError('invalid_request', false);
  }

  return {
    ...input,
    providerOrderReference: input.providerOrderCode.toString(),
    orderInfo: `Query transaction, tranid=${input.providerOrderCode.toString()}`,
  };
}

function parseVnPayQueryDrResponse(body: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new VnPayQueryDrError('malformed_response', false);
  }
  if (!isRecord(parsed)) {
    throw new VnPayQueryDrError('malformed_response', false);
  }

  const response: Record<string, string> = {};
  for (const field of QUERY_DR_RESPONSE_FIELDS) {
    const value = parsed[field];
    if (value === undefined) {
      response[field] = '';
      continue;
    }
    if (
      typeof value !== 'string' ||
      value.length > (QUERY_DR_RESPONSE_FIELD_LIMITS[field] as number) ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new VnPayQueryDrError('malformed_response', false);
    }
    response[field] = value;
  }

  if (!response.vnp_SecureHash) {
    throw new VnPayQueryDrError('invalid_response_signature', false);
  }
  return response;
}

function normalizeVnPayQueryDrResponse(
  config: VnPayProviderConfig,
  input: VnPayQueryDrAttempt & { providerOrderReference: string; orderInfo: string },
  response: Readonly<Record<string, string>>,
): VnPayQueryDrObservation {
  if (
    !verifyVnPayQueryDrResponseSignature(
      response,
      response.vnp_SecureHash,
      config.hashSecret as string,
    )
  ) {
    throw new VnPayQueryDrError('invalid_response_signature', false);
  }

  if (
    response.vnp_Command !== 'querydr' ||
    !/^\d{2}$/.test(response.vnp_ResponseCode) ||
    !isBoundedString(response.vnp_ResponseId, 32) ||
    !isBoundedString(response.vnp_Message, 255)
  ) {
    throw new VnPayQueryDrError('malformed_response', false);
  }
  if (
    response.vnp_TmnCode !== config.tmnCode ||
    response.vnp_TxnRef !== input.providerOrderReference
  ) {
    throw new VnPayQueryDrError('provider_fact_mismatch', false);
  }

  const queryRequestStatus = queryRequestStatusFor(response.vnp_ResponseCode);
  if (queryRequestStatus !== 'success') {
    return {
      provider: 'vnpay',
      queryRequestStatus,
      transactionStatus: 'unknown',
      providerOrderReference: input.providerOrderReference,
      currency: 'VND',
      responseCode: response.vnp_ResponseCode,
      trusted: true,
    };
  }

  const transactionNo = response.vnp_TransactionNo;
  if (!/^\d{1,15}$/.test(transactionNo) || BigInt(transactionNo) <= 0n) {
    throw new VnPayQueryDrError('malformed_response', false);
  }
  if (
    input.knownTransactionNo !== undefined &&
    transactionNo !== input.knownTransactionNo
  ) {
    throw new VnPayQueryDrError('provider_fact_mismatch', false);
  }

  const amountMinor = parseQueryDrAmount(response.vnp_Amount);
  if (amountMinor !== input.amountMinor) {
    throw new VnPayQueryDrError('provider_fact_mismatch', false);
  }

  const transactionStatusCode = response.vnp_TransactionStatus;
  if (!/^\d{2}$/.test(transactionStatusCode)) {
    throw new VnPayQueryDrError('malformed_response', false);
  }
  const transactionStatus = mapVnPayTransactionStatus(transactionStatusCode);
  const paidAt = response.vnp_PayDate
    ? parseVnPayQueryDrDate(response.vnp_PayDate)
    : undefined;

  return {
    provider: 'vnpay',
    queryRequestStatus: 'success',
    transactionStatus,
    providerOrderReference: input.providerOrderReference,
    providerTransactionIdentity: transactionNo,
    amountMinor,
    currency: 'VND',
    ...(paidAt && transactionStatus === 'paid' ? { paidAt } : {}),
    responseCode: response.vnp_ResponseCode,
    transactionStatusCode,
    trusted: true,
  };
}

function queryRequestStatusFor(
  responseCode: string,
): VnPayQueryDrRequestStatus {
  if (responseCode === '00') return 'success';
  if (responseCode === '91') return 'not_found';
  if (responseCode === '94') return 'duplicate_request';
  return 'provider_error';
}

function mapVnPayTransactionStatus(
  status: string,
): VnPayQueryDrTransactionStatus {
  return (
    {
      '00': 'paid',
      '01': 'pending',
      '02': 'failed',
      '04': 'reversed',
      '05': 'refund_processing',
      '06': 'refund_sent',
      '07': 'fraud_suspected',
      '08': 'expired',
      '09': 'refund_rejected',
      '10': 'delivered',
    } as const satisfies Record<string, VnPayQueryDrTransactionStatus>
  )[status] ?? 'unknown';
}

function parseQueryDrAmount(value: string): bigint {
  if (!/^\d{1,12}$/.test(value)) {
    throw new VnPayQueryDrError('malformed_response', false);
  }
  let amount: bigint;
  try {
    amount = BigInt(value);
  } catch {
    throw new VnPayQueryDrError('malformed_response', false);
  }
  if (
    amount <= 0n ||
    amount > VNPAY_AMOUNT_MAX ||
    amount % 100n !== 0n
  ) {
    throw new VnPayQueryDrError('malformed_response', false);
  }
  return amount / 100n;
}

function parseVnPayQueryDrDate(value: string): Date {
  if (!/^\d{14}$/.test(value)) {
    throw new VnPayQueryDrError('malformed_response', false);
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  if (
    year < 1970 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new VnPayQueryDrError('malformed_response', false);
  }
  const utc = Date.UTC(year, month - 1, day, hour, minute, second) - VN_TIMEZONE_OFFSET_MS;
  const result = new Date(utc);
  const roundTrip = new Date(result.getTime() + VN_TIMEZONE_OFFSET_MS);
  if (
    !Number.isFinite(result.getTime()) ||
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day ||
    roundTrip.getUTCHours() !== hour ||
    roundTrip.getUTCMinutes() !== minute ||
    roundTrip.getUTCSeconds() !== second
  ) {
    throw new VnPayQueryDrError('malformed_response', false);
  }
  return result;
}

function resolveQueryDrTimeout(configuredMs: number, requestedMs?: number): number {
  if (
    !Number.isInteger(configuredMs) ||
    configuredMs < 1000 ||
    configuredMs > 60000 ||
    (requestedMs !== undefined &&
      (!Number.isInteger(requestedMs) || requestedMs < 1 || requestedMs > configuredMs))
  ) {
    throw new VnPayQueryDrError('invalid_request', false);
  }
  return requestedMs === undefined ? configuredMs : requestedMs;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export function canonicalizeVnPayIpnParams(
  params: Readonly<Record<string, string>>,
): string {
  return canonicalizeVnPayParams(
    Object.fromEntries(
      Object.entries(params).filter(
        ([key]) => key !== 'vnp_SecureHash' && key !== 'vnp_SecureHashType',
      ),
    ),
  );
}

export function verifyVnPaySignature(
  params: Readonly<Record<string, string>>,
  secureHash: string,
  hashSecret: string,
): boolean {
  if (!/^[0-9a-f]{128}$/i.test(secureHash) || hashSecret.length === 0) {
    return false;
  }

  const expected = createHmac('sha512', hashSecret)
    .update(canonicalizeVnPayIpnParams(params), 'utf8')
    .digest('hex');
  const suppliedBuffer = Buffer.from(secureHash.toLowerCase(), 'ascii');
  const expectedBuffer = Buffer.from(expected, 'ascii');
  return (
    suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
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

export function isValidVnPayTmnCode(value: unknown): value is string {
  return typeof value === 'string' && VNPAY_TMN_CODE_PATTERN.test(value);
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

function isHttpsUrl(value: unknown): value is string {
  return isHttpUrl(value) && new URL(value).protocol === 'https:';
}
