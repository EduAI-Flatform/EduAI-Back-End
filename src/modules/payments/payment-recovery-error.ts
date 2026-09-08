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
  category?: 'prisma' | 'database' | 'application' | 'unknown';
}

const SAFE_CLASS_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/;
const PRISMA_CODE_PATTERN = /^P\d{4}$/;
const DATABASE_CODE_PATTERN = /^[0-9A-Z]{5}$/;

function safeDiagnostic(cause: unknown): PaymentRecoveryDiagnostic {
  if (!cause || typeof cause !== 'object') {
    return { category: 'unknown' };
  }

  const record = cause as Record<string, unknown>;
  const rawClass = (cause as { constructor?: { name?: unknown } }).constructor?.name;
  const causeClass =
    typeof rawClass === 'string' && SAFE_CLASS_PATTERN.test(rawClass)
      ? rawClass
      : undefined;
  const rawCode = record.code;
  const code = typeof rawCode === 'string' ? rawCode.toUpperCase() : undefined;
  const prismaCode = code && PRISMA_CODE_PATTERN.test(code) ? code : undefined;
  const databaseCode =
    code && !prismaCode && DATABASE_CODE_PATTERN.test(code) ? code : undefined;
  const category: PaymentRecoveryDiagnostic['category'] = prismaCode
    ? 'prisma'
    : databaseCode
      ? 'database'
      : causeClass && /exception|error/i.test(causeClass)
        ? 'application'
        : 'unknown';

  return {
    ...(causeClass ? { causeClass } : {}),
    ...(prismaCode ? { prismaCode } : {}),
    ...(databaseCode ? { databaseCode } : {}),
    category,
  };
}

function diagnosticSuffix(diagnostic: PaymentRecoveryDiagnostic): string {
  const fields = [
    diagnostic.causeClass ? `cause=${diagnostic.causeClass}` : null,
    diagnostic.prismaCode ? `prisma=${diagnostic.prismaCode}` : null,
    diagnostic.databaseCode ? `db=${diagnostic.databaseCode}` : null,
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
