import { UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';

type SubjectTransaction = Pick<Prisma.TransactionClient, '$queryRaw'>;
interface SubjectState { status: string; deletedAt: Date | null; }

/** Serialize issuance and revoke-all before their authoritative reads.
 * NO KEY UPDATE remains compatible with audit/identity foreign-key key shares.
 * The lock belongs to the caller's transaction, including Admin retry scopes.
 */
export async function lockAuthSubject(tx: SubjectTransaction, userId: string) {
  const rows = await tx.$queryRaw<SubjectState[]>`
    SELECT status, deleted_at AS "deletedAt" FROM users
    WHERE id = ${userId}::uuid FOR NO KEY UPDATE`;
  return rows[0];
}

export async function lockActiveAuthSubject(tx: SubjectTransaction, userId: string) {
  const state = await lockAuthSubject(tx, userId);
  if (!state || state.status !== 'active' || state.deletedAt) {
    throw new UnauthorizedException('Account unavailable.');
  }
}
