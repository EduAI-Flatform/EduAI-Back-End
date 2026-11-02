/** A licensed/contracted partner is authoritative for actual customer funds. */
export interface GdsWalletPartnerPort {
  getVerifiedBalance(linkReference: string): Promise<{ amountMinor: bigint; currency: 'VND'; asOf: Date }>;
  initiateTopup(input: { linkReference: string; amountMinor: bigint; idempotencyKey: string }): Promise<{
    operationId: string; status: 'PENDING_PARTNER' | 'REJECTED';
  }>;
  reserve(input: { linkReference: string; orderReference: string; amountMinor: bigint; idempotencyKey: string }): Promise<{
    reservationId: string; status: 'RESERVED' | 'UNKNOWN' | 'REJECTED';
  }>;
  capture(reservationId: string, idempotencyKey: string): Promise<'CAPTURED' | 'UNKNOWN' | 'REJECTED'>;
  release(reservationId: string, idempotencyKey: string): Promise<'RELEASED' | 'UNKNOWN' | 'REJECTED'>;
  refund(input: { originalCaptureReference: string; amountMinor: bigint; idempotencyKey: string }): Promise<{
    refundId: string; status: 'PENDING_PARTNER' | 'UNKNOWN' | 'REJECTED';
  }>;
  reconcile(operationId: string): Promise<'PENDING' | 'VERIFIED' | 'REJECTED' | 'UNKNOWN'>;
  /** Signature/source authenticity verification takes place BEFORE event projection. */
  verifyCallback(rawBody: Buffer, headers: Readonly<Record<string, string | undefined>>): Promise<{
    providerEventId: string; providerTransactionId: string; kind: string; amountMinor: bigint; currency: 'VND';
  }>;
}
