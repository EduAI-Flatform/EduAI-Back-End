import { isTransactionWriteConflict } from '../../prisma/transaction-conflict';

/** Wallet retries also include its existing unique-key/idempotency race. */
export function isRetryableGdsTransaction(error: unknown): boolean {
  return isTransactionWriteConflict(error) || Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002');
}
