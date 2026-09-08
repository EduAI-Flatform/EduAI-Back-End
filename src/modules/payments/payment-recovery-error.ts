export type PaymentRecoveryPhase = 'identity' | 'financial' | 'fulfillment';

export type PaymentRecoveryReasonCode =
  | 'PAYMENT_SETTLEMENT_CONFLICT'
  | 'PAYMENT_SETTLEMENT_PERSISTENCE_FAILED'
  | 'PAYMENT_FULFILLMENT_FAILED'
  | 'PAYMENT_TRANSACTION_RETRY_EXHAUSTED'
  | 'PAYMENT_RECOVERY_INTERNAL_ERROR';

export class PaymentRecoveryError extends Error {
  readonly name = 'PaymentRecoveryError';

  constructor(
    readonly phase: PaymentRecoveryPhase,
    readonly reasonCode: PaymentRecoveryReasonCode,
    readonly financiallyCommitted: boolean,
    readonly retryable: boolean,
    readonly settlementId?: string,
    _cause?: unknown,
  ) {
    super('Payment recovery failed.');
    Object.setPrototypeOf(this, new.target.prototype);
    void _cause;
  }
}
