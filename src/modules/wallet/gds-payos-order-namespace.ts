import { Prisma } from '../../../generated/prisma/client';

/**
 * Shared transaction-scoped mutex for allocating PayOS order codes in the
 * Commerce and internal-GDS namespaces. Both writers MUST take this lock
 * before their respective INSERT, inside the same database transaction.
 *
 * Source-only PAYW-04B prerequisite: this is not a topup API or a license
 * to create PayOS payment links. Existing production Commerce skips this
 * because the GDS schema/feature is absent there.
 */
export async function lockGdsPayosOrderNamespace(tx: Prisma.TransactionClient): Promise<void> {
  // pg_advisory_xact_lock returns PostgreSQL void, which Prisma 7 cannot
  // deserialize through $queryRaw. The volatile FROM function still acquires
  // the transaction-scoped mutex, while the result is a supported integer.
  await tx.$queryRaw<{ acquired: number }[]>(
    Prisma.sql`SELECT 1::integer AS acquired FROM pg_advisory_xact_lock(474453, 404)`,
  );
}
