export type PaymentRecoveryPhase = 'identity' | 'financial' | 'fulfillment';

export type PaymentRecoveryReasonCode =
  | 'PAYMENT_SETTLEMENT_CONFLICT'
  | 'PAYMENT_SETTLEMENT_PERSISTENCE_FAILED'
  | 'PAYMENT_FULFILLMENT_FAILED'
  | 'PAYMENT_TRANSACTION_RETRY_EXHAUSTED'
  | 'PAYMENT_RECOVERY_INTERNAL_ERROR';

export interface PaymentRecoveryDiagnostic {
  causeClass?: string;
  prismaCode?: string;
  databaseCode?: string;
  driverKind?: string;
  category?: 'prisma' | 'database' | 'application' | 'unknown';
}

const SAFE_CLASS_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/;
const SAFE_KIND_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const PRISMA_CODE_PATTERN = /^P\d{4}$/;
const DATABASE_CODE_PATTERN = /^[0-9A-Z]{5}$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : undefined;
}

function safeClassName(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const rawClass = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof rawClass === 'string' && SAFE_CLASS_PATTERN.test(rawClass)
    ? rawClass
    : undefined;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' ? value.toUpperCase() : undefined;
}

function nestedAdapterCause(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const directCause = asRecord(record.cause);
  if (directCause) return directCause;

  const meta = asRecord(record.meta);
  const driverAdapterError = asRecord(meta?.driverAdapterError);
  return asRecord(driverAdapterError?.cause);
}

function safeDiagnostic(cause: unknown): PaymentRecoveryDiagnostic {
  if (!cause || typeof cause !== 'object') {
    return { category: 'unknown' };
  }

  const record = cause as Record<string, unknown>;
  const nested = nestedAdapterCause(record);
  const causeClass = safeClassName(cause);

  const topCode = safeCode(record.code);
  const nestedCode = safeCode(nested?.code);
  const nestedOriginalCode = safeCode(nested?.originalCode);
  const candidateCodes = [topCode, nestedCode, nestedOriginalCode].filter(
    (value): value is string => Boolean(value),
  );

  const prismaCode = candidateCodes.find((code) => PRISMA_CODE_PATTERN.test(code));
  const databaseCode = candidateCodes.find(
    (code) => !PRISMA_CODE_PATTERN.test(code) && DATABASE_CODE_PATTERN.test(code),
  );

  const rawKind = nested?.kind;
  const driverKind =
    typeof rawKind === 'string' && SAFE_KIND_PATTERN.test(rawKind)
      ? rawKind
      : undefined;

  const category: PaymentRecoveryDiagnostic['category'] = prismaCode
    ? 'prisma'
    : databaseCode || driverKind === 'postgres'
      ? 'database'
      : causeClass && /exception|error/i.test(causeClass)
        ? 'application'
        : 'unknown';

  return {
    ...(causeClass ? { causeClass } : {}),
    ...(prismaCode ? { prismaCode } : {}),
    ...(databaseCode ? { databaseCode } : {}),
    ...(driverKind ? { driverKind } : {}),
    category,
  };
}

function diagnosticSuffix(diagnostic: PaymentRecoveryDiagnostic): string {
  const fields = [
    diagnostic.causeClass ? `cause=${diagnostic.causeClass}` : null,
    diagnostic.prismaCode ? `prisma=${diagnostic.prismaCode}` : null,
    diagnostic.databaseCode ? `db=${diagnostic.databaseCode}` : null,
    diagnostic.driverKind ? `driver=${diagnostic.driverKind}` : null,
    diagnostic.category ? `category=${diagnostic.category}` : null,
  ].filter(Boolean);
  return fields.length > 0 ? ` [${fields.join(' ')}]` : '';
}

export class PaymentRecoveryError extends Error {
  readonly name = 'PaymentRecoveryError';
  readonly diagnostic: PaymentRecoveryDiagnostic;

  constructor(
    readonly phase: PaymentRecoveryPhase,
    readonly reasonCode: PaymentRecoveryReasonCode,
    readonly financiallyCommitted: boolean,
    readonly retryable: boolean,
    readonly settlementId?: string,
    cause?: unknown,
  ) {
    const diagnostic = safeDiagnostic(cause);
    super(`Payment recovery failed.${diagnosticSuffix(diagnostic)}`);
    this.diagnostic = diagnostic;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
