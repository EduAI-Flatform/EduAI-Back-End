import { UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '../../../generated/prisma/client';

export interface SessionIdentity { tokenVersion: 2; authRevision: number; sid: string; }
export interface SessionPayload extends SessionIdentity { sub: string; tokenUse: 'access' | 'refresh'; jti?: string; }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isSessionPayload(value: unknown, use: SessionPayload['tokenUse']): value is SessionPayload {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return p.tokenVersion === 2 && p.tokenUse === use && typeof p.sub === 'string' && p.sub.length > 0 &&
    Number.isSafeInteger(p.authRevision) && (p.authRevision as number) >= 0 &&
    typeof p.sid === 'string' && uuid.test(p.sid) &&
    (use !== 'refresh' || (typeof p.jti === 'string' && uuid.test(p.jti)));
}
export function refreshTokenDigest(token: string): string {
  return 'sha256:v2:' + createHash('sha256').update(token, 'utf8').digest('hex');
}
export function matchesRefreshToken(token: string, digest: string): boolean {
  if (!/^sha256:v2:[0-9a-f]{64}$/.test(digest)) return false;
  return timingSafeEqual(Buffer.from(refreshTokenDigest(token)), Buffer.from(digest));
}
/** Call inside the mutation's subject fence, not only in the HTTP guard. */
export async function assertActiveSession(reader: Pick<Prisma.TransactionClient, 'user' | 'refreshToken'>,
  user: { id: string; authRevision?: number; sid?: string; tokenVersion?: number },
) {
  if (user.tokenVersion !== 2 || !Number.isSafeInteger(user.authRevision) || (user.authRevision ?? -1) < 0 || !user.sid || !uuid.test(user.sid))
    throw new UnauthorizedException('Session changed. Sign in again.');
  const current = await reader.user.findUnique({ where: { id: user.id }, select: { authRevision: true } });
  if (!current || current.authRevision !== user.authRevision) throw new UnauthorizedException('Session changed. Sign in again.');
  const family = await reader.refreshToken.findFirst({ where: { userId: user.id, sessionFamilyId: user.sid, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } });
  if (!family) throw new UnauthorizedException('Session changed. Sign in again.');
}
