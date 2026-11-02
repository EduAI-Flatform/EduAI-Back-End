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
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(474453, 404)`);
}
