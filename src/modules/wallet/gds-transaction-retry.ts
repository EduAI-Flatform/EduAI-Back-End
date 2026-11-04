/** Prisma 7 pg adapter can wrap serialization failures from raw row-lock queries. */
export function isRetryableGdsTransaction(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const failure = error as { code?: string; name?: string; cause?: { kind?: string }; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string; kind?: string } } } };
  if (failure.code === 'P2034' || failure.code === 'P2002') return true;
  const cause = failure.meta?.driverAdapterError?.cause;
  return ((failure.code === 'P2010' || failure.code === 'P2039') &&
    (failure.meta?.code === '40001' || cause?.originalCode === '40001' || cause?.kind === 'TransactionWriteConflict')) ||
    (failure.name === 'DriverAdapterError' && failure.cause?.kind === 'TransactionWriteConflict');
}
